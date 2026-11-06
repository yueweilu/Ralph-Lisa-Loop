import * as path from "node:path";

export type HerdrLaunchOptions = {
  project: string;
  task: string;
  fullAuto: boolean;
};

export type AutoRoute =
  | { host: "tmux"; args: string[] }
  | { host: "herdr"; options: HerdrLaunchOptions };

/** Keep implicit auto byte-for-byte compatible; only explicit --host opts into strict parsing. */
export function routeAutoArgs(args: string[]): AutoRoute {
  const hostIndices = args.flatMap((value, index) => value === "--host" ? [index] : []);
  if (hostIndices.length === 0) return { host: "tmux", args };
  if (hostIndices.length !== 1) throw new Error("HOST_OPTION_REPEATED");
  const index = hostIndices[0];
  const host = args[index + 1];
  if (host !== "tmux" && host !== "herdr") throw new Error("HOST_INVALID");
  const withoutHost = [...args.slice(0, index), ...args.slice(index + 2)];
  if (host === "tmux") {
    if (withoutHost.some((arg) => arg === "--project")) throw new Error("PROJECT_REQUIRES_HERDR");
    return { host, args: withoutHost };
  }
  return { host, options: parseHerdrLaunchOptions(withoutHost) };
}

export function parseHerdrLaunchOptions(args: string[]): HerdrLaunchOptions {
  let project: string | undefined;
  let fullAuto = false;
  let task: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project") {
      if (project !== undefined) throw new Error("PROJECT_OPTION_REPEATED");
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error("PROJECT_REQUIRED");
      project = value;
    } else if (arg === "--full-auto") {
      if (fullAuto) throw new Error("FULL_AUTO_OPTION_REPEATED");
      fullAuto = true;
    } else if (arg.startsWith("-")) {
      throw new Error("UNKNOWN_OPTION");
    } else if (task !== undefined) {
      throw new Error("TASK_MUST_BE_ONE_ARGUMENT");
    } else {
      task = arg;
    }
  }
  if (!task?.trim()) throw new Error("TASK_REQUIRED");
  return { project: path.resolve(project ?? process.cwd()), task, fullAuto };
}
