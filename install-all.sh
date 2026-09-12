#!/usr/bin/env bash
# 一键安装本仓库的插件、额度补丁和 Hub ACP。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

DRY_RUN=0
USE_GIT=0
REPLACE=0
SKIP_KIMI=0
SKIP_HUB=0
SKIP_QUOTA=0

usage() {
  cat <<'EOF'
用法: ./install-all.sh [选项]

从本仓库安装全部包：
  - paseo-director / paseo-usage-glance / paseo-file-upload
  - Antigravity 额度补丁、Kimi 按需续期
  - Antigravity Hub ACP

已从本仓库安装的会跳过。仍指向旧单仓库的默认只警告，加 --replace 才会卸掉再装。

选项:
  --git          插件从 GitHub 安装（paseo plugin add lalaze/paseo-plugins --path …）
                 默认从本仓库本地目录安装，本目录需长期保留
  --replace      卸掉旧来源后改从本仓库安装；Hub 对已有条目使用 --replace-existing
  --skip-quota   不装 Antigravity 额度补丁
  --skip-kimi    不装 Kimi 续期补丁
  --skip-hub     不装 Antigravity Hub ACP
  --dry-run      只打印将要执行的步骤
  -h, --help     显示说明
EOF
}

for arg in "$@"; do
  case "$arg" in
    --git) USE_GIT=1 ;;
    --replace) REPLACE=1 ;;
    --skip-quota) SKIP_QUOTA=1 ;;
    --skip-kimi) SKIP_KIMI=1 ;;
    --skip-hub) SKIP_HUB=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

ok=0
skip=0
warn=0
fail=0
need_restart=0
need_reload=0
RESULTS=()

note() { RESULTS+=("$1"); }
say() { printf '%s\n' "$*"; }
snippet() { tr '\n' ' ' <"$1" | cut -c1-200; }
tmpfile() { mktemp "${TMPDIR:-/tmp}/paseo.XXXXXX"; }

if ! command -v paseo >/dev/null 2>&1; then
  echo "未找到 paseo，请先把 Paseo CLI 放到 PATH，并在 Settings → Plugins 开启插件。" >&2
  exit 127
fi
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node。" >&2
  exit 127
fi

PLUGIN_JSON="$(paseo plugin ls --json)"

refresh_plugins() {
  PLUGIN_JSON="$(paseo plugin ls --json)"
}

classify_plugin() {
  local id="$1" dir="$2"
  PLUGIN_JSON="$PLUGIN_JSON" ROOT="$ROOT" node --input-type=module -e '
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

const id = process.argv[1];
const dir = process.argv[2];
const root = process.env.ROOT;
const plugins = JSON.parse(process.env.PLUGIN_JSON);
const plugin = plugins.find((item) => item.id === id);
if (!plugin) {
  process.stdout.write(JSON.stringify({ kind: "missing" }));
  process.exit(0);
}

const remote = String(plugin.remote || "");
const normalized = remote
  .trim()
  .replace(/\.git$/i, "")
  .replace(/^git@github\.com:/, "github.com/")
  .replace(/^https?:\/\//, "")
  .replace(/^ssh:\/\/git@/, "");
const thisRepo = normalized === "github.com/lalaze/paseo-plugins" || normalized === "lalaze/paseo-plugins";
let localHere = false;
try {
  if (plugin.path && existsSync(plugin.path)) {
    localHere = realpathSync(plugin.path) === realpathSync(join(root, dir));
  }
} catch {}

let kind = "other";
if (plugin.source === "git" && thisRepo) kind = "git";
else if (localHere) kind = "local";

process.stdout.write(JSON.stringify({
  kind,
  remote,
  path: plugin.path || "",
  source: plugin.source || "local",
  status: plugin.status || "",
}));
' "$id" "$dir"
}

info_field() {
  local json="$1" field="$2"
  JSON="$json" node -e "const j=JSON.parse(process.env.JSON); const v=j[process.argv[1]]; process.stdout.write(v == null ? '' : String(v))" "$field"
}

install_plugin() {
  local dir="$1" id="$2"
  local info kind path remote
  info="$(classify_plugin "$id" "$dir")"
  kind="$(info_field "$info" kind)"

  add_plugin() {
    if [ "$USE_GIT" = 1 ]; then
      say "→ paseo plugin add lalaze/paseo-plugins --path $dir"
      if [ "$DRY_RUN" = 1 ]; then
        return 0
      fi
      paseo plugin add lalaze/paseo-plugins --path "$dir"
    else
      say "→ paseo plugin install $ROOT/$dir"
      if [ "$DRY_RUN" = 1 ]; then
        return 0
      fi
      paseo plugin install "$ROOT/$dir"
    fi
  }

  case "$kind" in
    git|local)
      note "SKIP $id（已从本仓库安装）"
      skip=$((skip + 1))
      ;;
    missing)
      if add_plugin; then
        note "OK   $id"
        ok=$((ok + 1))
        need_reload=1
        [ "$DRY_RUN" = 0 ] && refresh_plugins
      else
        note "FAIL $id（安装失败）"
        fail=$((fail + 1))
      fi
      ;;
    *)
      path="$(info_field "$info" path)"
      remote="$(info_field "$info" remote)"
      if [ "$REPLACE" = 1 ]; then
        say "→ 替换 $id（${remote:-$path}）"
        if [ "$DRY_RUN" = 1 ]; then
          note "DRY $id（remove + install）"
          ok=$((ok + 1))
          return
        fi
        if paseo plugin remove "$id" && add_plugin; then
          note "OK   $id（已从旧来源切换到本仓库）"
          ok=$((ok + 1))
          need_reload=1
          refresh_plugins
        else
          note "FAIL $id（替换失败）"
          fail=$((fail + 1))
        fi
      else
        note "WARN $id 已从其他来源安装（${remote:-$path}）。加 --replace 可卸掉后改从本仓库安装。"
        warn=$((warn + 1))
      fi
      ;;
  esac
}

install_patch() {
  local pkg="$1"
  local script="$2"
  local label="$3"
  local check_out=""
  local apply_out=""
  local installed=""
  local check_err=""
  say "-> ${label} check"
  check_err="$(tmpfile)"
  if ! check_out="$(node "$ROOT/agy-quota/$script" check 2>"$check_err")"; then
    note "FAIL ${pkg} (check: $(snippet "$check_err"))"
    rm -f "$check_err"
    fail=$((fail + 1))
    return
  fi
  rm -f "$check_err"
  installed="$(info_field "$check_out" installed)"
  if [ "$installed" = "true" ]; then
    note "SKIP ${pkg} (already installed)"
    skip=$((skip + 1))
    return
  fi
  if [ "$DRY_RUN" = 1 ]; then
    note "DRY ${pkg} apply"
    ok=$((ok + 1))
    return
  fi
  say "-> ${label} apply"
  if apply_out="$(node "$ROOT/agy-quota/$script" apply)"; then
    say "$apply_out"
    note "OK   ${pkg}"
    ok=$((ok + 1))
    need_restart=1
  else
    note "FAIL ${pkg} (apply: ${apply_out%%$'\n'*})"
    fail=$((fail + 1))
  fi
}

install_hub() {
  local check_out=""
  local installed=""
  local command=""
  local apply_out=""
  local hub_err=""
  say "-> antigravity-hub check"
  hub_err="$(tmpfile)"
  if ! check_out="$(node "$ROOT/antigravity-hub/hub.mjs" check 2>"$hub_err")"; then
    note "FAIL antigravity-hub (check: $(snippet "$hub_err"))"
    rm -f "$hub_err"
    fail=$((fail + 1))
    return
  fi
  rm -f "$hub_err"
  installed="$(info_field "$check_out" installed)"
  if [ "$installed" = "true" ]; then
    note "SKIP antigravity-hub（已从本仓库安装）"
    skip=$((skip + 1))
    return
  fi
  command="$(info_field "$check_out" configuredCommand)"
  if [ -n "$command" ] && [ "$REPLACE" != 1 ]; then
    note "WARN antigravity-hub 已有配置但不是本仓库路径。加 --replace 后会 --replace-existing 覆盖。"
    warn=$((warn + 1))
    return
  fi
  if [ "$DRY_RUN" = 1 ]; then
    if [ "$REPLACE" = 1 ] && [ -n "$command" ]; then
      note "DRY antigravity-hub install --replace-existing"
    else
      note "DRY antigravity-hub install"
    fi
    ok=$((ok + 1))
    return
  fi
  if [ "$REPLACE" = 1 ] && [ -n "$command" ]; then
    say "→ antigravity-hub install --replace-existing"
    if apply_out="$(node "$ROOT/antigravity-hub/hub.mjs" install --replace-existing)"; then
      say "$apply_out"
      note "OK   antigravity-hub（已替换）"
      ok=$((ok + 1))
      need_reload=1
    else
      note "FAIL antigravity-hub（${apply_out%%$'\n'*})"
      fail=$((fail + 1))
    fi
    return
  fi
  say "→ antigravity-hub install"
  if apply_out="$(node "$ROOT/antigravity-hub/hub.mjs" install)"; then
    say "$apply_out"
    note "OK   antigravity-hub"
    ok=$((ok + 1))
    need_reload=1
  else
    note "FAIL antigravity-hub（${apply_out%%$'\n'*})"
    fail=$((fail + 1))
  fi
}

install_plugin director paseo-director
install_plugin usage-glance paseo-usage-glance
install_plugin file-upload paseo-file-upload

if [ "$SKIP_QUOTA" = 1 ]; then
  note "SKIP agy-quota（--skip-quota）"
  skip=$((skip + 1))
else
  install_patch agy-quota patch.mjs "Antigravity 额度补丁"
fi

if [ "$SKIP_KIMI" = 1 ]; then
  note "SKIP kimi-quota（--skip-kimi）"
  skip=$((skip + 1))
else
  install_patch kimi-quota kimi-patch.mjs "Kimi 续期补丁"
fi

if [ "$SKIP_HUB" = 1 ]; then
  note "SKIP antigravity-hub（--skip-hub）"
  skip=$((skip + 1))
else
  install_hub
fi

if [ "$DRY_RUN" = 0 ]; then
  if [ "$need_restart" = 1 ]; then
    say "→ paseo daemon restart"
    if paseo daemon restart; then
      note "OK   paseo daemon restart"
      ok=$((ok + 1))
    else
      note "FAIL paseo daemon restart"
      fail=$((fail + 1))
    fi
  elif [ "$need_reload" = 1 ]; then
    say "→ paseo reload"
    if paseo reload; then
      note "OK   paseo reload"
      ok=$((ok + 1))
    else
      note "FAIL paseo reload"
      fail=$((fail + 1))
    fi
  fi
fi

say ""
say "=== 安装结果 ==="
for line in "${RESULTS[@]}"; do
  say "$line"
done
say "完成：成功 $ok，跳过 $skip，警告 $warn，失败 $fail"

if [ "$fail" -gt 0 ]; then
  exit 1
fi
exit 0
