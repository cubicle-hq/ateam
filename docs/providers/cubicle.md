# Cubicle

Cubicle provides persistent Linux Boxes reached over its private WireGuard tunnel.
Ateam can create a Box directly from the app or attach to an existing Box over SSH.

## First run

1. Install the Cubicle CLI and run `cubicle tunnel install` once. The tunnel
   installer asks for administrator privileges.
2. In Ateam, open **Settings → Boxes → Add a box → Create a new box**. Select
   **Cubicle**, click **Connect Cubicle**, and approve the connection in the
   Cubicle Dashboard. Ateam prepares the reusable image while the form shows progress.
3. Add or select a local project. If it needs setup, configure an initializer as described below.
   In **New task**, select **Run on → New Cubicle sandbox** and choose a coding agent.
   For example, choose Codex and ask it to create a Next.js app and start it on port
   3000. Complete the agent's sign-in on the Box when prompted.
4. Open the **Cubicle** menu in the task toolbar and select **Port 3000** to preview
   the app. Select **Desktop** to open the Box's graphical session.

Verified against Cubicle production with Ateam's desktop development build on
November 16, 2026. Tested connection approval, image capture, fresh Box
provisioning, Codex, the desktop, and the in-app port preview.

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
`CB_CLI_API_URL` and `CB_CLI_API_KEY`, and the tunnel helper from
`cubicle tunnel install` must already be installed. Boxes belong to Ateam's own
account (`ORG/ateam-xxxxxx`), so Resume setup only finds boxes Ateam created.

## One sandbox per task

In the New task dialog, select **Run on → New Cubicle sandbox**. The selection is
remembered for subsequent tasks. Each submission creates a fresh 2-vCPU, 4-GiB,
20-GiB Cubicle box using the connected organization and API environment.

Ateam's **Prepare repository on this Mac** step packages Git history and collects
uncommitted edits, deletions, and new files that Git does not ignore. The Box
clones the Git bundle and applies those changes. Local-only commits travel with
the bundle. Ignored build output, dependencies, and other Ateam worktrees stay
on the Mac. Use the initializer to install dependencies or check out submodules.
The transfer uses the Box's pinned SSH connection and needs no GitHub credentials.

The task's new worktree is based on the local HEAD. Once seeding finishes, Ateam
restores the changes into that worktree. If your project needs setup before
the agent starts, set an initializer in `.ateam/sandbox.json`:

```json
{"initializer": "bash scripts/setup-dev.sh"}
```

When no initializer is configured, Ateam checks `.ateam/init.sh`, `scripts/init.sh`,
`init.sh`, `scripts/setup.sh`, then `setup.sh`. If none exists, Ateam starts the
task after restoring the checkout. This repository supplies `scripts/init.sh`,
which reinstalls Linux dependencies and builds the headless engine. An initializer,
when present, must succeed before the composer launches the chosen agent. The chosen agent CLI is installed
in the box; account authentication follows the existing box credential settings.

Failures retain the box and its files for inspection. Boxes are persistent and
are not automatically deleted when a task is removed. Progress appears in the
app while Ateam prepares the Git files, provisions the Box, and sets up the task.

To retry a failed setup, expand **Resume an unfinished sandbox** in the composer
and enter the retained box name. Ateam collects the current Git history and local changes and resumes
that box instead of creating another. Completed sandboxes and tasks with active
terminal sessions cannot be overwritten through this option.

Task sandboxes use the worktree branch name as their Cubicle box name (up to Cubicle's 40-character limit). SSH uses `<branch>.<org>.cubicle.internal`; existing private-IP SSH entries migrate on resume. If the organization already has a box with that name, choose another task name or explicitly resume the unfinished setup.

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

## Reusable Ateam image

After approving **Connect Cubicle**, Ateam looks for a sandbox image that matches
its runtime and desktop assets. The first connection builds it on a dedicated Box using Cubicle
capacity. The connection form shows the builder, tool installation, and snapshot
steps. Later connections and task launches reuse the saved image for that
organization and Ateam connection.

The image contains the Ateam engine, Node.js and npm, supported agent CLIs,
Chrome, the Linux desktop packages, and the Cubicle wallpaper. A Box initializes
its own desktop profile and pairing state.
Ateam copies the current checkout into each task Box, runs the repository's
initializer and start hook, and configures the selected agent there. The image
builder receives no repository, agent credentials, or desktop connection.

Existing connections without snapshot permission can choose **Enable reusable
image**. If the image build fails, the connection stays usable and Ateam can set
up Boxes from the standard Cubicle image. Ateam stops failed builders where
possible and retains them for inspection.

New Cubicle tasks default to OpenCode with MiniMax M3.1 Flash through Fireworks AI.
Ateam copies the selected provider credential to the individual task Box over
SSH. The task's checkout copy still includes local ignored and untracked files.
