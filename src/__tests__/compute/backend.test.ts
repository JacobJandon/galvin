import { describe, it, expect } from "vitest";
import {
  LocalComputeBackend,
  SshComputeBackend,
  UnconfiguredComputeBackend,
  getComputeBackend,
} from "../../compute/backend.js";

describe("LocalComputeBackend", () => {
  it("runs a command and captures stdout", async () => {
    const r = await new LocalComputeBackend().exec("echo galvin-ok");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("galvin-ok");
  });

  it("reports a non-zero exit code", async () => {
    const r = await new LocalComputeBackend().exec("exit 3");
    expect(r.exitCode).toBe(3);
  });
});

describe("SshComputeBackend", () => {
  it("builds correct non-interactive ssh args", () => {
    const be = new SshComputeBackend({ host: "deploy@box", port: 2222, identityFile: "/keys/id" });
    const args = be.buildArgs("uname -a");
    expect(args).toContain("-o");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("-p");
    expect(args).toContain("2222");
    expect(args).toContain("-i");
    expect(args).toContain("/keys/id");
    // host then command come last, in order
    expect(args[args.length - 2]).toBe("deploy@box");
    expect(args[args.length - 1]).toBe("uname -a");
    expect(be.id).toBe("ssh:deploy@box");
  });
});

describe("getComputeBackend selector", () => {
  it("defaults to local", () => {
    expect(getComputeBackend().kind).toBe("local");
    expect(getComputeBackend({ backend: "local" }).kind).toBe("local");
  });

  it("builds ssh when host is given, throws without", () => {
    expect(getComputeBackend({ backend: "ssh", ssh: { host: "u@h" } }).kind).toBe("ssh");
    expect(() => getComputeBackend({ backend: "ssh" })).toThrow(/requires compute\.ssh\.host/);
  });

  it("returns honest unconfigured adapters for modal/daytona that throw on exec", async () => {
    const modal = getComputeBackend({ backend: "modal" });
    expect(modal.kind).toBe("modal");
    expect(modal).toBeInstanceOf(UnconfiguredComputeBackend);
    await expect(modal.exec("echo x")).rejects.toThrow(/not configured/);

    const daytona = getComputeBackend({ backend: "daytona" });
    await expect(daytona.exec("echo x")).rejects.toThrow(/not configured/);
  });
});
