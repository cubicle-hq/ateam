#!/usr/bin/env python3
"""Provision a production Cubicle Box and install Ateam over its private tunnel."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time


def run(args, env, capture=False, timeout=600):
    result = subprocess.run(args, env=env, text=True, capture_output=capture, timeout=timeout)
    if result.returncode:
        detail = result.stderr.strip() if capture else "see output above"
        raise RuntimeError(f"{args[0]} failed ({result.returncode}): {detail}")
    return result.stdout if capture else None


def label(value):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,61}[a-z0-9]|[a-z0-9]", value):
        raise argparse.ArgumentTypeError("use a DNS label: lowercase letters, numbers, hyphens")
    return value


def positive(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be positive")
    return number


def discover_alias(path, alias):
    text = path.read_text() if path.exists() else ""
    if any(re.match(r"^\s*Host\s+", line, re.I) and alias in line.split()[1:]
           for line in text.splitlines()):
        return
    with path.open("a") as config:
        config.write(f"\n# Ateam discovery; connection options are in Cubicle's Include.\nHost {alias}\n")
    path.chmod(0o600)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--org", required=True, type=label)
    parser.add_argument("--name", required=True, type=label)
    parser.add_argument("--identity", required=True, type=Path, help="registered SSH identity (private key or agent-backed .pub)")
    parser.add_argument("--alias", type=label)
    parser.add_argument("--vcpus", type=positive, default=2)
    parser.add_argument("--memory", type=positive, default=4096, help="MiB")
    parser.add_argument("--disk", type=positive, default=20, help="GiB")
    parser.add_argument("--resume", action="store_true", help="explicitly use an existing same-named Box")
    opts = parser.parse_args()
    identity = opts.identity.expanduser().absolute()
    if not identity.is_file() and not Path(str(identity) + ".pub").is_file():
        parser.error("identity or its .pub file must exist; register the public key with cubicle keys add first")
    for program in ("cubicle", "ssh", "scp"):
        if not shutil.which(program):
            parser.error(f"{program} is required")
    env = {**os.environ, "CB_CLI_API_URL": "https://api.cubicle.sh"}
    alias = opts.alias or f"ateam-{opts.name}"
    box = f"{opts.org}/{opts.name}"
    cli = ["cubicle"]
    # List first: authentication/network errors must never be treated as 'not found'.
    boxes = json.loads(run(cli + ["boxes", "list", "--org", opts.org, "--json"], env, True))
    existing = next((item for item in boxes if item["name"] == opts.name), None)
    if existing and not opts.resume:
        parser.error(f"{box} exists; choose another name or explicitly pass --resume")
    if opts.resume and not existing:
        parser.error(f"{box} does not exist; omit --resume to create it")
    run(cli + ["tunnel", "status"], env)
    if existing:
        print(f"Resuming {box}; requested sizing is not applied", flush=True)
        if existing.get("state") != "running":
            run(cli + ["boxes", "start", box, "--wait"], env)
    else:
        print(f"Creating {box}; on later failure it is retained. Retry with --resume.", flush=True)
        run(cli + ["boxes", "create", "--org", opts.org, opts.name,
                   "--vcpus", str(opts.vcpus), "--memory", str(opts.memory),
                   "--disk", str(opts.disk), "--wait"], env)
    run(cli + ["connect"], env)
    run(cli + ["ssh-config", box, "--alias", alias, "--identity", str(identity)], env)
    discover_alias(Path.home() / ".ssh" / "config", alias)
    # Follow Cubicle DNS across box restarts and address changes.
    host_option = f"HostName={opts.name}.{opts.org}.cubicle.internal"
    ssh = ["ssh", "-o", host_option, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", alias]
    for attempt in range(12):
        try:
            run(ssh + ["true"], env, True, timeout=15)
            break
        except (RuntimeError, subprocess.TimeoutExpired):
            if attempt == 11:
                raise RuntimeError("SSH unavailable; check registered key and Cubicle tunnel. Box retained.")
            time.sleep(5)
    installer = Path(__file__).resolve().parents[1] / "packages/server/scripts/install.sh"
    # An owned temporary path avoids collisions with other installers.
    remote = run(ssh + ["mktemp /tmp/ateam-install.XXXXXXXX"], env, True).strip()
    if not re.fullmatch(r"/tmp/ateam-install\.[A-Za-z0-9]+", remote):
        raise RuntimeError("unexpected remote temporary path")
    try:
        run(["scp", "-o", host_option, "-o", "BatchMode=yes", str(installer), f"{alias}:{remote}"], env)
        run(ssh + [f"bash {remote} --service"], env)
    finally:
        run(ssh + [f"rm -f {remote}"], env)
    run(ssh + ["systemctl is-active ateam"], env, timeout=30)
    print(f"Ready: {box}. In Ateam select SSH alias {alias}. Agent and GitHub sign-ins are separate.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"Provisioning stopped: {error}\nNo Boxes were deleted.", file=sys.stderr)
        sys.exit(1)
