import { runCli } from "./eg";

runCli(process.argv.slice(2), {
  env: process.env,
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
}).then((code) => {
  process.exitCode = code;
});
