#!/usr/bin/env node
import { parseHerdrLaunchOptions } from "./herdr/options.js";
import { reportHerdrLaunch } from "./herdr/launch.js";

const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  console.log('Usage: herdr-rll [--project PATH] [--full-auto] "TASK"');
  process.exit(0);
}

try { reportHerdrLaunch(parseHerdrLaunchOptions(args)); }
catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : "INVALID_HERDR_OPTIONS"}`);
  process.exitCode = 2;
}
