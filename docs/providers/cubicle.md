# Cubicle

Cubicle provides persistent Linux Boxes reached over its private WireGuard tunnel.
Ateam can create a Box directly from the app or attach to an existing Box over SSH.

## First run

1. Nothing to install by hand. Ateam ships the Cubicle CLI. The first time it needs
   the private network, it installs Cubicle's network helper and macOS asks for your
   password once.
2. In Ateam, open **Settings → Boxes → Add a box → Create a new box**. Select
   **Cubicle**, click **Connect Cubicle**, and approve the connection in the
   Cubicle Dashboard. Ateam prepares the reusable image while the form shows progress.
3. Add or select a local project. In **New task**, select **Run on → New Cubicle
   sandbox**. Select **Set up project environment** once, so later sandboxes start
   from a prepared project image (see [Lifecycle](#lifecycle)). Then choose a coding agent.
   For example, choose Codex and ask it to create a Next.js app and start it on port
   3000. Complete the agent's sign-in on the Box when prompted.
4. Open the **Cubicle** menu in the task toolbar and select **Port 3000** to preview
   the app. Select **Desktop** to open the Box's graphical session.

Verified against Cubicle production with Ateam's desktop development build on
November 16, 2026. Tested connection approval, image capture, fresh Box
provisioning, Codex, the desktop, and the in-app port preview.

The lifecycle described below (project images, Box removal, and repair of the network
helper) is covered by unit tests. It has not yet been run end to end against Cubicle
production.

## Set up an existing Box over SSH

These commands explicitly select production.

```sh
export CB_CLI_API_URL=https://api.cubicle.sh
cubicle login --api "$CB_CLI_API_URL"
cubicle boxes create --org YOUR_ORG ateam --vcpus 2 --memory 4096 --disk 20 --wait
# Register your workstation's public SSH key if you have not already done so:
cubicle keys add ~/.ssh/id_ed25519.pub
cubicle tunnel install
cubicle connect
cubicle ssh-config YOUR_ORG/ateam --alias ateam-cubicle
```

The tunnel installation needs administrator privileges and is only needed once.
For automation, the CLI accepts `CB_CLI_API_KEY` together with `CB_CLI_API_URL`.
Use a dedicated service account with the appropriate Box grants.

## Ateam discovery

Cubicle writes the complete SSH configuration into `~/.ssh/cubicle_config` and
includes it from `~/.ssh/config`. Ateam 0.1.89 only discovers Host declarations in
the main config file. Append this empty declaration **after** Cubicle's Include:

```sshconfig
Host ateam-cubicle
```

OpenSSH still gets the identity, private address and pinned host key from Cubicle's
included configuration. Do not disable host-key checking or copy those settings
into a second configuration that can drift.

Verify `ssh ateam-cubicle true`, then select the alias in Ateam under
Settings → Boxes → Add a box → Set up a box over SSH. The app installs its engine.
Alternatively, copy this repository's `packages/server/scripts/install.sh` to the
Box and run it as the guest user with `bash install.sh --service`.

Connect GitHub and an agent CLI on the Box before running coding tasks. The Mac's
agent credentials are not automatically available inside the Box.

## Lifecycle and phone access

Keep the Box running while using Ateam. This recipe does not implement Cubicle
sleep/wake adapters or automatic wake on connection. Start a stopped Box with
`cubicle boxes start YOUR_ORG/ateam --wait`, then reconnect the tunnel.
Cubicle's workstation tunnel does not itself provide Ateam Go phone connectivity;
phone access through Tailscale requires separate setup and has not been tested.

## Automated provisioning

From this checkout, with Python 3, the Cubicle CLI, an installed Cubicle tunnel,
and an already registered SSH identity:

```sh
python3 scripts/create-cubicle-box.py \
  --org dries --name my-agent-box --identity ~/.ssh/dries.cubicle
```

This creates a production Box (2 vCPU, 4096 MiB RAM, 20 GiB disk), connects the
private tunnel, writes its pinned SSH configuration and Ateam discovery alias,
installs the engine, and checks the service. Override `--vcpus`, `--memory` (MiB),
`--disk` (GiB), or `--alias` as needed. Authentication uses the existing Cubicle login
or `CB_CLI_API_KEY`; the production URL is explicitly set by the script.
Agent-backed identities such as 1Password SSH keys are supported.

Existing names are refused. Pass `--resume` explicitly to resume a partially
configured Box; it starts the existing Box and reruns the installer without
resizing. Failures retain the Box and its data; there is no automatic deletion.
Select the resulting SSH alias in Ateam to connect. GitHub/agent sign-ins and phone
access remain separate.

## Desktop creation flow

The desktop Create a box dialog uses **Connect Cubicle** (see
[cubicle-connect.md](cubicle-connect.md)): the person approves Ateam for one
organization in the browser and Ateam stores its own key, encrypted, in the main
process. The CLI login is no longer used. Connect is available on staging and production. The desktop uses
`https://api.cubicle.sh` by default. To use staging, set
`ATEAM_CUBICLE_API_URL=https://controller-staging.tailc41a49.ts.net`.
Box listing, creation, start and SSH key registration use the HTTP API with the key.
`cubicle connect` and `cubicle ssh-config` still run through the CLI with
`CB_CLI_API_URL` and `CB_CLI_API_KEY`. Ateam installs and repairs the tunnel helper
itself (`apps/desktop/src/main/cubicle-tunnel.ts`). Boxes belong to Ateam's own
account (`ORG/ateam-xxxxxx`), so Resume setup only finds boxes Ateam created.

## Lifecycle

Every task worktree gets its own Box. Three images make that fast:

| Image | Holds | Made by | Made when |
| --- | --- | --- | --- |
| Ateam image | Engine, Node.js, agent CLIs, Chrome, desktop | Ateam, with no project or credentials | Once per Ateam release and organization |
| Project image | The Ateam image, plus one project ready to work on | An agent, in the project's environment chat | When you select **Save project image** |
| Task Box | The project image, plus one worktree | Ateam | Every new sandbox task |

### Project environment

In the New task dialog, select **Run on → New Cubicle sandbox**. The line under the
prompt shows which image the sandbox starts from. Select **Set up project
environment**. Ateam creates the project's environment Box (`ateam-env-<project>-<id>`)
from the Ateam image, copies the repository into it, and opens a task named
**Project environment**. Its agent receives a brief: read how the project is set up,
install toolchains and services system-wide, install dependencies in the main
checkout, and verify the result. What you typed in the prompt is added to the brief.
Complete agent and GitHub sign-ins in this Box; they become part of the image.

When the agent reports that it is done, select **Save project image** in the task.
Ateam stops the Box, saves its disk as a snapshot named
`ateam-project.<project>.<commit>.<time>`, and leaves the Box stopped. The snapshot
lives as long as the environment Box, so do not delete that Box in the Dashboard.

To change the image later, select **Update environment** in the same place. Ateam
starts the Box, sends the commits made since, and reopens the chat. Save again when
done. New sandboxes use the newest image; running ones keep their disk.

The engine's own state (its database, pairing and the chat history) is not part of
the image. Ateam sets it aside before the snapshot and restores it when the
environment Box starts again. A Box made from the image starts as a new engine.

### One Box per task

Each sandbox task creates a 2-vCPU Box named after the task. With a project image,
the Box already has the checkout, its dependencies and the sign-ins. This Mac sends
only the commits made since the image was saved, plus uncommitted edits, deletions
and new files that Git does not ignore. Without a project image, the Box starts from
the Ateam image and receives the whole Git history.

The engine creates the task's worktree at the Mac's HEAD and seeds it from the main
checkout (installed dependencies and env files). Ateam then applies the uncommitted
changes on top. Ignored files on the Mac are never sent. The transfer uses the Box's
pinned SSH connection and needs no GitHub credentials.

If each worktree needs a command after it is created, or the app should start with
the task, set them in `.ateam/sandbox.json`:

```json
{"initializer": "bun install --frozen-lockfile", "start": "bun dev &"}
```

When no initializer is configured, Ateam checks `.ateam/init.sh`, `scripts/init.sh`,
`init.sh`, `scripts/setup.sh`, then `setup.sh`. A hook that fails does not fail the
task: the task opens with a warning that quotes the hook's output, and its agent can
fix it. With a project image the initializer should be short, because the image has
already done the expensive work.

Removing a task removes its Box when that was the Box's last task. The environment
Box is never removed this way.

### When something fails

Ateam checks the Cubicle connection, its permissions and the private network before
it creates a Box. A Box whose setup fails afterwards is deleted, so retrying is just
submitting the task again; there is nothing to resume or clean up. Set
`ATEAM_CUBICLE_KEEP_FAILED=1` to keep failed Boxes for inspection.

| Message | What Ateam did | What you do |
| --- | --- | --- |
| Cubicle's network helper stopped running / is not installed | Asked macOS for administrator access and reinstalled the helper from its own CLI | Approve the prompt. If you cancelled it, try again |
| It still does not answer after a repair | Reinstalled the helper, which did not start | Run `cubicle tunnel install` in Terminal |
| The private connection could not be re-established | Dropped the session and connected again, once | Try again; check your network |
| No box was created. Retry after Cubicle capacity is available | Nothing was allocated | Retry later, or delete unused Boxes |
| The project's initializer failed | Created the task anyway | Let the task's agent fix it, or change `.ateam/sandbox.json` |

Connections approved before this lifecycle lack the `boxes:delete` permission. The
first sandbox task opens the Cubicle approval page to add it.

For local development, set `ATEAM_CUBICLE_CLI` to the absolute path of a
locally built Cubicle CLI. The CLI resolves application keys to authenticated
Cubicle identities before selecting a WireGuard device. Use a build with that
support if the tunnel reports that the device key is already registered.

## Preview a task's web app

Start the HTTP server in the Cubicle task, then open the **Cubicle** menu in the
task toolbar and select its port. Ateam discovers listening ports when the menu
opens. Use **Refresh ports** if you started the server while the menu was open.
The browser panel connects through a local SSH forward to the Box, so a server
bound to the Box's `127.0.0.1` works. Closing the preview closes the forward.

Choose **Desktop** in the same menu to open the graphical session at 1280 × 960.

Use the sandbox's `start` hook to start the server when Ateam prepares the task.
The hook should leave the server running in the background and exit once it is
ready.

## The Ateam image

After approving **Connect Cubicle**, Ateam looks for an image that matches its
runtime and desktop assets. The first connection builds it on a dedicated Box
(`gold-runtime-…`) using Cubicle capacity. The connection form shows the builder,
tool installation, and snapshot steps. Later connections, environment Boxes and
task Boxes without a project image reuse it.

The image contains the Ateam engine, Node.js and npm, supported agent CLIs,
Chrome, the Linux desktop packages, and the Cubicle wallpaper. The builder receives
no repository, agent credentials, or desktop connection. Its Box stays stopped,
because the snapshot lives only as long as it. Builders of earlier Ateam releases
are deleted once the current image exists, and a builder whose build failed is
deleted at once.

If the image build fails, the connection stays usable and Ateam sets up Boxes from
the standard Cubicle image. A Box made from an older project image keeps its engine
until a released build of Ateam connects and upgrades it.

New Cubicle tasks default to OpenCode with MiniMax M3.1 Flash through Fireworks AI.
Ateam copies the selected provider credential to the individual task Box over
SSH.
