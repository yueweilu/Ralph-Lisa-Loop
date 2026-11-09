#!/usr/bin/env node
import { parseHerdrLaunchOptions, parseHerdrStatusOptions } from "./herdr/options.js";
import { reportHerdrLaunch } from "./herdr/launch.js";
import { reportHerdrLaunchStatus } from "./herdr/launch-status.js";

const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  console.log('Usage: herdr-rll [--project PATH] [--full-auto] "TASK"');
  console.log('New sessions automatically commit eligible candidates; source remains unverified.');
  console.log('       herdr-rll status [--project PATH]');
  process.exit(0);
}

try {
  if (args[0] === "status") reportHerdrLaunchStatus(parseHerdrStatusOptions(args.slice(1)));
  else reportHerdrLaunch(parseHerdrLaunchOptions(args));
}
catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : "INVALID_HERDR_OPTIONS"}`);
  process.exitCode = 2;
}
