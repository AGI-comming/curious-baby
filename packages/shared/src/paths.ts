import os from "node:os";
import path from "node:path";

export type BabyPaths = {
  home: string;
  config: string;
  envExample: string;
  database: string;
  pid: string;
  constitution: string;
  memories: string;
  archives: string;
  logs: string;
  runtimeLog: string;
  auditLog: string;
  reflectionsLog: string;
};

export function getBabyHome(): string {
  return process.env.CURIOUS_BABY_HOME ?? path.join(os.homedir(), ".curious-baby");
}

export function getBabyPaths(home = getBabyHome()): BabyPaths {
  return {
    home,
    config: path.join(home, "config.json"),
    envExample: path.join(home, ".env.example"),
    database: path.join(home, "baby.sqlite"),
    pid: path.join(home, "baby.pid"),
    constitution: path.join(home, "constitution.md"),
    memories: path.join(home, "memories"),
    archives: path.join(home, "memories", "archives"),
    logs: path.join(home, "logs"),
    runtimeLog: path.join(home, "logs", "runtime.log"),
    auditLog: path.join(home, "logs", "audit.log"),
    reflectionsLog: path.join(home, "logs", "reflections.log")
  };
}
