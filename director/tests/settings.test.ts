import assert from "node:assert/strict";
import test from "node:test";
import { commandLine, makeCheck, parseCommandLine, validateSettings } from "../client/settings-model";
import { settings } from "./helpers";

test("whole check commands retain quoted paths, empty arguments and literal punctuation", () => {
  assert.deepEqual(parseCommandLine('pnpm run test -- "path with spaces" --name=\'a b\' ""'), { command: "pnpm", args: ["run", "test", "--", "path with spaces", "--name=a b", ""] });
  const command = { command: "/tools/my python", args: ["-m", "pytest", "", "it's working", '$HOME', "a;b", "C:\\project\\test", 'a"b', "a`b", "a\tb"] };
  assert.deepEqual(parseCommandLine(commandLine(command)), command);
});

test("check command input rejects shell operators, expansion and malformed input", () => {
  for (const line of ["", "npm test && npm run build", "npm test | cat", "npm test > result", "echo $HOME", "echo `pwd`", 'echo "$(pwd)"', 'npm test "unfinished', "npm test\\", "npm test\nwhoami", "npm test\\\nwhoami", "npm\0test"]) {
    assert.throws(() => parseCommandLine(line), Error, line);
  }
  assert.deepEqual(parseCommandLine("echo 'literal $HOME | >'"), { command: "echo", args: ["literal $HOME | >"] });
});

test("check editing preserves timeouts and provides useful validation", () => {
  assert.deepEqual(makeCheck("python -m pytest", "", "5"), { label: "python -m pytest", command: "python", args: ["-m", "pytest"], timeoutMs: 300000 });
  assert.throws(() => makeCheck("npm test", "test", "0"), /timeout/);
  assert.throws(() => makeCheck("npm test", "test", "11"), /timeout/);
  assert.throws(() => validateSettings({}), /Choose the AI responsible for planning/);
});

test("choosing the two roles is enough to save; previous optional checks remain intact", () => {
  const original = settings();
  assert.deepEqual(validateSettings(original), original);
  const { verificationCommands, ...roles } = original;
  assert.deepEqual(validateSettings(roles).verificationCommands, []);
  assert.deepEqual(validateSettings({ ...roles, verificationCommands: [] }).verificationCommands, []);
});
