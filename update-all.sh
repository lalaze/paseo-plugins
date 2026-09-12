#!/usr/bin/env bash
# 一键更新本仓库已安装的插件、额度补丁和 Hub ACP。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

SKIP_PULL=0
DRY_RUN=0

usage() {
  cat <<'EOF'
用法: ./update-all.sh [--skip-pull] [--dry-run]

拉取本仓库最新 main，然后更新已经安装的：
  - paseo-director / paseo-usage-glance / paseo-file-upload
  - Antigravity 额度补丁、可选 Kimi 续期
  - Antigravity Hub ACP

未安装的会跳过。从旧单仓库安装的会提示先按各目录 README 迁移，不会改它们。
GitHub 源插件走 paseo plugin update；本仓库本地目录安装的先 git pull 再 reload。
EOF
}

for arg in "$@"; do
  case "$arg" in
    --skip-pull) SKIP_PULL=1 ;;
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
run() {
  if [ "$DRY_RUN" = 1 ]; then
    say "DRY  $*"
    return 0
  fi
  "$@"
}

if ! command -v paseo >/dev/null 2>&1; then
  echo "未找到 paseo，请先把 Paseo CLI 放到 PATH。" >&2
  exit 127
fi
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node。" >&2
  exit 127
fi
if ! command -v git >/dev/null 2>&1; then
  echo "未找到 git。" >&2
  exit 127
fi

if [ "$SKIP_PULL" = 1 ]; then
  note "SKIP git pull (--skip-pull)"
  skip=$((skip + 1))
elif [ ! -d "$ROOT/.git" ]; then
  note "SKIP git pull（不是 git 仓库）"
  skip=$((skip + 1))
else
  say "→ git pull --ff-only"
  if [ "$DRY_RUN" = 1 ]; then
    note "DRY git pull --ff-only"
    ok=$((ok + 1))
  elif out="$(git pull --ff-only 2>&1)"; then
    note "OK   git pull"
    ok=$((ok + 1))
    say "$out"
  else
    note "FAIL git pull: $out"
    fail=$((fail + 1))
    say "$out" >&2
  fi
fi

PLUGIN_JSON="$(paseo plugin ls --json)"

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

update_plugin() {
  local dir="$1" id="$2"
  local info kind
  info="$(classify_plugin "$id" "$dir")"
  kind="$(PLUGIN_JSON="$info" node -e 'process.stdout.write(JSON.parse(process.env.PLUGIN_JSON).kind)')"

  case "$kind" in
    missing)
      note "SKIP $id（未安装）"
      skip=$((skip + 1))
      ;;
    git)
      say "→ paseo plugin update $id"
      if run paseo plugin update "$id"; then
        note "OK   $id（GitHub 更新）"
        ok=$((ok + 1))
      else
        note "FAIL $id（paseo plugin update）"
        fail=$((fail + 1))
      fi
      ;;
    local)
      say "→ 本地 $dir：npm ci、typecheck、reload"
      if [ "$DRY_RUN" = 1 ]; then
        note "DRY $id（本地 reload）"
        ok=$((ok + 1))
        return
      fi
      if (
        cd "$ROOT/$dir"
        npm ci --include=dev --ignore-scripts
        npm run typecheck
        paseo plugin reload "$id"
      ); then
        note "OK   $id（本地 reload）"
        ok=$((ok + 1))
      else
        note "FAIL $id（本地 reload）"
        fail=$((fail + 1))
      fi
      ;;
    *)
      local path remote
      path="$(PLUGIN_JSON="$info" node -e 'process.stdout.write(JSON.parse(process.env.PLUGIN_JSON).path || "")')"
      remote="$(PLUGIN_JSON="$info" node -e 'process.stdout.write(JSON.parse(process.env.PLUGIN_JSON).remote || "")')"
      note "WARN $id 不是从本仓库安装（${remote:-$path}）。请先按 $dir/README.md 迁移后再更新。"
      warn=$((warn + 1))
      ;;
  esac
}

json_field() {
  local json="$1" field="$2"
  JSON="$json" node -e "const j=JSON.parse(process.env.JSON); process.stdout.write(String(j[process.argv[1]] ?? ''))" "$field"
}

update_patch() {
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
  installed="$(json_field "$check_out" installed)"
  if [ "$installed" != "true" ]; then
    note "SKIP ${pkg} (not installed)"
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
    if [[ "$apply_out" == *"Already applied"* || "$apply_out" == *"already applied"* ]]; then
      note "OK   ${pkg} (up to date)"
    else
      note "OK   ${pkg} (applied)"
      need_restart=1
    fi
    ok=$((ok + 1))
  else
    note "FAIL ${pkg} (apply: ${apply_out%%$'\n'*})"
    fail=$((fail + 1))
  fi
}

update_hub() {
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
  installed="$(json_field "$check_out" installed)"
  if [ "$installed" = "true" ]; then
    if [ "$DRY_RUN" = 1 ]; then
      note "DRY antigravity-hub install"
      ok=$((ok + 1))
      return
    fi
    say "→ antigravity-hub install"
    if apply_out="$(node "$ROOT/antigravity-hub/hub.mjs" install)"; then
      say "$apply_out"
      if [[ "$apply_out" == *"Already installed"* ]]; then
        note "OK   antigravity-hub（已是最新）"
      else
        note "OK   antigravity-hub（已安装）"
        need_reload=1
      fi
      ok=$((ok + 1))
    else
      note "FAIL antigravity-hub（install: ${apply_out%%$'\n'*})"
      fail=$((fail + 1))
    fi
    return
  fi
  command="$(json_field "$check_out" configuredCommand)"
  if [ -n "$command" ] && [ "$command" != "null" ]; then
    note "WARN antigravity-hub 已配置但不是本仓库路径。请先按 antigravity-hub/README.md 迁移。"
    warn=$((warn + 1))
  else
    note "SKIP antigravity-hub（未安装）"
    skip=$((skip + 1))
  fi
}

update_plugin director paseo-director
update_plugin usage-glance paseo-usage-glance
update_plugin file-upload paseo-file-upload
update_patch agy-quota patch.mjs "Antigravity 额度补丁"
update_patch kimi-quota kimi-patch.mjs "Kimi 续期补丁"
update_hub

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
say "=== 更新结果 ==="
for line in "${RESULTS[@]}"; do
  say "$line"
done
say "完成：成功 $ok，跳过 $skip，警告 $warn，失败 $fail"

if [ "$fail" -gt 0 ]; then
  exit 1
fi
if [ "$warn" -gt 0 ]; then
  exit 0
fi
exit 0
