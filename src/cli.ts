#!/usr/bin/env node
import { run } from "./run.js";

process.exitCode = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
});
