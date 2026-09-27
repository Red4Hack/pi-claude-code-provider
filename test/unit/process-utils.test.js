import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { withTimeout, waitFor } from "../support/wait.js";
import { ProcessTerminationError, forceTerminateProcessTreeSync, superviseProcess, terminateProcessGroup } from "../../src/process-utils.ts";
import { nodeFixtureArgs } from "../support/node-fixture.js";

async function assertProcessGone(pid) {
    await waitFor(() => {
        try { process.kill(pid, 0); return false; }
        catch (error) { if (error.code === "ESRCH") return true; throw error; }
    }, "process death");
}

test("supervisor terminates a process that exceeds its total deadline", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let failure;
    const supervisor = superviseProcess(child, { idleTimeoutMs: 1000, totalTimeoutMs: 30, onFailure(error) { failure = error; } });
    const result = await supervisor.wait();
    supervisor.dispose();
    assert.match(failure?.message, /exceeded 30ms/);
    if (process.platform === "win32") assert.deepEqual(result, { code: 1, signal: null });
    else assert.notEqual(result.signal, null);
});
test("supervisor terminates a process that exceeds its idle deadline", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let failure;
    const supervisor = superviseProcess(child, { idleTimeoutMs: 30, totalTimeoutMs: 1000, onFailure(error) { failure = error; } });
    await supervisor.wait();
    supervisor.dispose();
    assert.match(failure?.message, /no protocol activity for 30ms/);
});
test("supervisor reports only the first pipe failure", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const failures = [];
    const supervisor = superviseProcess(child, { idleTimeoutMs: 1000, totalTimeoutMs: 1000, onFailure(error) { failures.push(error.message); } });
    child.stdin.emit("error", new Error("EPIPE"));
    child.stdout.emit("error", new Error("secondary"));
    await supervisor.wait();
    supervisor.dispose();
    assert.deepEqual(failures, ["Claude Code stdin failed: EPIPE"]);
});
test("a closed stdin is left for the exit to explain", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(4), 100)"], { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const failures = [];
    const supervisor = superviseProcess(child, { idleTimeoutMs: 5_000, totalTimeoutMs: 10_000, onFailure(error) { failures.push(error.message); } });
    try {
        for (const code of ["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"]) {
            child.stdin.emit("error", Object.assign(new Error(`write ${code}`), { code }));
        }
        const result = await withTimeout(supervisor.wait(), "child settlement");
        assert.deepEqual(failures, []);
        assert.equal(result.code, 4);
        assert.equal(result.stdinClosed, true);
    } finally {
        supervisor.dispose();
        await supervisor.terminate();
    }
});
test("protocol activity cannot rearm the idle timer after settlement or disposal", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const failures = [];
    // The idle timer runs from spawn, and a loaded runner can take longer than a
    // short deadline just to start Node, so only failures after settlement count.
    const supervisor = superviseProcess(child, { idleTimeoutMs: 500, totalTimeoutMs: 10_000, onFailure(error) { failures.push(error); } });
    try {
        await withTimeout(supervisor.wait(), "child settlement");
        const settledFailures = failures.length;
        supervisor.touch();
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.equal(failures.length, settledFailures);
        supervisor.dispose();
        supervisor.touch();
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.equal(failures.length, settledFailures);
    } finally {
        supervisor.dispose();
        await supervisor.terminate();
    }
});
test("supervisor rejects and quiesces when termination cannot establish process death", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const failures = [];
    const supervisor = superviseProcess(child, {
        idleTimeoutMs: 1_000,
        totalTimeoutMs: 30,
        onFailure(error) { failures.push(error); },
        terminate: async () => { throw new Error("synthetic terminator EPERM"); },
    });
    try {
        await assert.rejects(
            withTimeout(supervisor.wait(), "process settlement"),
            (error) => error instanceof ProcessTerminationError && /liveness is unknown.*EPERM/.test(error.message),
        );
        assert.equal(failures.length, 2);
        assert.match(failures[0].message, /exceeded 30ms/);
        assert.ok(failures[1] instanceof ProcessTerminationError);
        assert.equal(child.stdout.destroyed, true);
        assert.equal(child.stderr.destroyed, true);
        assert.equal(child.exitCode, null);
    } finally {
        supervisor.dispose();
        await terminateProcessGroup(child);
    }
});
test("caller-initiated termination failure also rejects supervisor wait promptly", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const supervisor = superviseProcess(child, {
        idleTimeoutMs: 1_000,
        totalTimeoutMs: 1_000,
        onFailure() {},
        terminate: async () => { throw new Error("synthetic direct terminator EPERM"); },
    });
    try {
        await assert.rejects(supervisor.terminate(), ProcessTerminationError);
        await assert.rejects(
            withTimeout(supervisor.wait(), "process settlement"),
            /liveness is unknown.*direct terminator EPERM/,
        );
        assert.equal(child.exitCode, null);
        assert.equal(child.stdout.destroyed, true);
    } finally {
        supervisor.dispose();
        await terminateProcessGroup(child);
    }
});
test("Windows termination removes only the exact owned process tree", { skip: process.platform !== "win32" }, async () => {
    // PID-reporting children use the preload because restricted sandboxes can
    // discard buffered Node stdout while leaving the process exit successful.
    const body = `const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); process.stdout.write(String(child.pid)+"\\n"); setInterval(()=>{},1000);`;
    const target = spawn(process.execPath, nodeFixtureArgs(["-e", body]), { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
    try {
        const descendantPid = await new Promise((resolve) => target.stdout.once("data", (chunk) => resolve(Number(chunk.toString().trim()))));
        await terminateProcessGroup(target);
        await assertProcessGone(descendantPid);
        assert.deepEqual({ code: target.exitCode, signal: target.signalCode }, { code: 1, signal: null });
        assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
    }
    finally {
        await terminateProcessGroup(target);
        await terminateProcessGroup(unrelated);
    }
});
test("process-group termination removes a descendant", { skip: process.platform === "win32" }, async () => {
    const body = `const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); process.stdout.write(String(child.pid)+"\\n"); setInterval(()=>{},1000);`;
    const parent = spawn(process.execPath, nodeFixtureArgs(["-e", body]), { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const pid = await new Promise((resolve) => parent.stdout.once("data", (chunk) => resolve(Number(chunk.toString().trim()))));
    await terminateProcessGroup(parent);
    await assertProcessGone(pid);
});
test("process-group termination tolerates EPERM from an existence probe", { skip: process.platform === "win32" }, async () => {
    const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    let injected = false;
    const killProcess = (pid, signal) => {
        if (signal === 0 && !injected) {
            injected = true;
            const error = new Error("synthetic process-group probe EPERM");
            error.code = "EPERM";
            error.errno = -1;
            error.syscall = "kill";
            throw error;
        }
        return process.kill(pid, signal);
    };
    await terminateProcessGroup(parent, 500, killProcess);
    assert.equal(injected, true);
    await assertProcessGone(parent.pid);
});
test("process-group termination reports signal permission failures with context", { skip: process.platform === "win32" }, async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const denySignal = () => {
        const error = new Error("synthetic process-group signal EPERM");
        error.code = "EPERM";
        error.errno = -1;
        error.syscall = "kill";
        throw error;
    };
    try {
        await assert.rejects(
            terminateProcessGroup(child, 500, denySignal),
            new RegExp(`Process group ${child.pid} cleanup failed during SIGTERM.*code=EPERM.*syscall=kill`),
        );
    }
    finally {
        process.kill(-child.pid, "SIGKILL");
        await new Promise((resolve) => child.once("close", resolve));
    }
});
test("process-group termination removes a descendant after its leader exits", { skip: process.platform === "win32" }, async () => {
    const body = `const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); child.unref(); process.stdout.write(String(child.pid)+"\\n");`;
    const parent = spawn(process.execPath, nodeFixtureArgs(["-e", body]), { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const pid = await new Promise((resolve) => parent.stdout.once("data", (chunk) => resolve(Number(chunk.toString().trim()))));
    await new Promise((resolve) => parent.once("close", resolve));
    await terminateProcessGroup(parent);
    await assertProcessGone(pid);
});
for (const owned of [true, false]) {
    test(`supervisor records only its own termination signals (${owned ? "owned" : "external"} SIGKILL)`, { skip: process.platform === "win32", timeout: 5000 }, async () => {
        const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);'], {
            detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        const supervisor = superviseProcess(child, { idleTimeoutMs: 10000, totalTimeoutMs: 10000, onFailure() {} });
        try {
            await once(child, "message");
            if (owned) await supervisor.terminate();
            else process.kill(-child.pid, "SIGKILL");
            const result = await supervisor.wait();
            assert.equal(result.code, null);
            assert.equal(result.signal, "SIGKILL");
            assert.deepEqual(result.terminationSignals, owned ? ["SIGTERM", "SIGKILL"] : undefined);
        } finally {
            supervisor.dispose();
            await terminateProcessGroup(child);
        }
    });
}

test("supervisor termination is idempotent", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const supervisor = superviseProcess(child, { idleTimeoutMs: 1000, totalTimeoutMs: 1000, onFailure() { } });
    const first = supervisor.terminate();
    assert.equal(supervisor.terminate(), first);
    await first;
    await supervisor.wait();
    supervisor.dispose();
});

for (const inheritedPipes of [true, false]) {
    test(`failed tree cleanup after leader exit retains unknown liveness (${inheritedPipes ? "open pipes" : "closed pipes"})`, { skip: process.platform === "win32", timeout: 5000 }, async () => {
        const body = `const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:${inheritedPipes ? '"inherit"' : '"ignore"'}}); child.unref();`;
        const child = spawn(process.execPath, ["-e", body], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
        const exited = once(child, "exit");
        const closed = once(child, "close");
        const supervisor = superviseProcess(child, {
            idleTimeoutMs: 10000, totalTimeoutMs: 10000, onFailure() {},
            terminate: async () => { throw new Error("synthetic surviving-group EPERM"); },
        });
        try {
            await exited;
            assert.equal(child.exitCode, 0);
            assert.doesNotThrow(() => process.kill(-child.pid, 0));
            if (!inheritedPipes) await closed;
            const first = supervisor.terminate();
            assert.equal(supervisor.terminate(), first);
            await assert.rejects(first, ProcessTerminationError);
            if (inheritedPipes) {
                await assert.rejects(supervisor.wait(), ProcessTerminationError);
                assert.equal(child.stdout.destroyed, true);
            } else {
                assert.equal((await supervisor.wait()).code, 0);
            }
        } finally {
            supervisor.dispose();
            await terminateProcessGroup(child);
        }
    });
}

test("supervisor reports a confirmed termination once", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const outcomes = [];
    const supervisor = superviseProcess(child, { idleTimeoutMs: 10_000, totalTimeoutMs: 10_000, onFailure() {}, onTermination: (outcome) => outcomes.push(outcome) });
    try {
        await supervisor.terminate();
        await supervisor.terminate();
        await supervisor.wait();
        assert.deepEqual(outcomes, ["confirmed"]);
    } finally {
        supervisor.dispose();
    }
});

test("supervisor reports unknown liveness from any termination path, and a throwing observer changes nothing", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const outcomes = [];
    const supervisor = superviseProcess(child, {
        idleTimeoutMs: 10_000,
        // The deadline starts this termination, not a caller.
        totalTimeoutMs: 30,
        onFailure() {},
        terminate: async () => { throw new Error("synthetic terminator EPERM"); },
        onTermination: (outcome) => {
            outcomes.push(outcome);
            throw new Error("observer failure");
        },
    });
    try {
        await assert.rejects(withTimeout(supervisor.wait(), "process settlement"), ProcessTerminationError);
        await assert.rejects(supervisor.terminate(), ProcessTerminationError);
        assert.deepEqual(outcomes, ["unknown"]);
    } finally {
        supervisor.dispose();
        await terminateProcessGroup(child);
    }
});

test("synchronous forced termination removes the owned group, descendants included", { skip: process.platform === "win32" }, async () => {
    const body = `const {spawn}=require("node:child_process"); const grandchild=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); process.stdout.write(String(grandchild.pid)+"\\n"); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["-e", body], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const [line] = await once(child.stdout, "data");
    const grandchild = Number(String(line).trim());
    assert.equal(forceTerminateProcessTreeSync(child.pid, child), true);
    await assertProcessGone(child.pid);
    await assertProcessGone(grandchild);
    // Already gone: ESRCH is still an established absence.
    assert.equal(forceTerminateProcessTreeSync(child.pid, child), true);
});

test("synchronous forced termination reports unknown liveness when it cannot signal", () => {
    const failing = (code) => () => { throw Object.assign(new Error(code), { code }); };
    const denied = failing("EPERM");
    const force = (kill, groupMemberStates) => forceTerminateProcessTreeSync(1234, undefined, { platform: "linux", kill, groupMemberStates });
    // macOS answers EPERM for a group of unreaped zombies, the usual state at exit.
    assert.equal(force(denied, () => ["Z"]), true);
    assert.equal(force(denied, () => ["Z+", "Zs"]), true);
    assert.equal(force(denied, () => []), true, "the group vanished between the signal and the listing");
    assert.equal(force(denied, () => ["S"]), false, "a live member keeps the state");
    assert.equal(force(denied, () => ["Z", "R+"]), false);
    assert.equal(force(denied, () => undefined), false, "an unreadable listing is unknown");
    assert.equal(force(failing("EINVAL"), () => ["Z"]), false);
    assert.equal(forceTerminateProcessTreeSync(0, undefined, { platform: "linux", kill: () => true }), false);
});

test("the group listing behind an EPERM sees a live member", { skip: process.platform === "win32" }, async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    try {
        await once(child, "spawn");
        const denied = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
        assert.equal(forceTerminateProcessTreeSync(child.pid, child, { kill: denied }), false);
    } finally {
        process.kill(-child.pid, "SIGKILL");
        await once(child, "close");
    }
});

test("synchronous forced termination on Windows trusts only taskkill's own outcome", () => {
    const run = (status, child) => {
        const calls = [];
        const outcome = forceTerminateProcessTreeSync(4321, child, { platform: "win32", taskkill: (pid) => { calls.push(pid); return status; } });
        return { outcome, calls };
    };
    assert.deepEqual(run(0), { outcome: true, calls: [4321] });
    assert.deepEqual(run(128), { outcome: true, calls: [4321] });
    assert.deepEqual(run(1), { outcome: false, calls: [4321] });
    assert.deepEqual(run(null), { outcome: false, calls: [4321] });
    // An exited leader cannot be traced to descendants, and its PID may be reused.
    assert.deepEqual(run(0, { exitCode: 0, signalCode: null }), { outcome: true, calls: [] });
});

// macOS refuses to signal a group whose members are all unreaped zombies. A
// fake child and killer drive terminateProcessGroup through that answer.
function zombieGroupKiller({ sigterm = "ok", sigkill = "ok", probeBeforeKill = "ESRCH" } = {}) {
    let killed = false;
    const raise = (code) => { throw Object.assign(new Error(code), { code }); };
    return (pid, signal) => {
        if (signal === "SIGTERM") { if (sigterm !== "ok") raise(sigterm); return true; }
        if (signal === "SIGKILL") { killed = true; if (sigkill !== "ok") raise(sigkill); return true; }
        // Signal 0: the existence probe. After SIGKILL the reap has happened.
        return raise(killed ? "ESRCH" : probeBeforeKill);
    };
}
const zombieChild = { pid: 424_242, exitCode: null, signalCode: null };

test("process-group termination treats a zombie-only group's EPERM as delivered", { skip: process.platform === "win32" }, async () => {
    await terminateProcessGroup(zombieChild, 50, zombieGroupKiller({ sigterm: "EPERM" }), () => ["Z"]);
    await terminateProcessGroup(zombieChild, 50, zombieGroupKiller({ sigterm: "EPERM" }), () => ["Z+", "Zs"]);
    // Still unreaped when the grace period ends: SIGKILL meets the same EPERM.
    await terminateProcessGroup(zombieChild, 50, zombieGroupKiller({ sigkill: "EPERM", probeBeforeKill: "EPERM" }), () => ["Z"]);
});

test("process-group termination still fails on EPERM when a member may be alive", { skip: process.platform === "win32" }, async () => {
    for (const states of [["S"], ["Z", "R+"], undefined]) {
        await assert.rejects(
            terminateProcessGroup(zombieChild, 50, zombieGroupKiller({ sigterm: "EPERM" }), () => states),
            /Process group 424242 cleanup failed during SIGTERM/,
            JSON.stringify(states),
        );
    }
    await assert.rejects(
        terminateProcessGroup(zombieChild, 50, zombieGroupKiller({ sigkill: "EPERM", probeBeforeKill: "EPERM" }), () => ["S"]),
        /cleanup failed during SIGKILL/,
    );
    await assert.rejects(terminateProcessGroup(zombieChild, 50, zombieGroupKiller({ sigterm: "EINVAL" }), () => ["Z"]), /cleanup failed during SIGTERM/);
});
