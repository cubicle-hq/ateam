# Connect Cubicle

**Connect Cubicle** opens the Dashboard for approval in one Cubicle organization.
Ateam receives a dedicated application credential. The desktop implementation
is in `apps/desktop/src/main/cubicle.ts`.

- Cubicle spec and full reference: `cubicle_core/docs/APPLICATIONS.md` (Cubicle commit
  `5a741ec`, Linear CB-26).
- **Live on staging and production:** production (`https://api.cubicle.sh`) is the
  desktop default. Set `ATEAM_CUBICLE_API_URL=https://controller-staging.tailc41a49.ts.net`
  to test against staging.

## Connection flow

1. `POST {API}/v1/auth/device` with `{ "clientId": "ateam" }`. Optional
   `"scope": [...]` to ask for other permissions; the default is
   `boxes:read, boxes:create, boxes:power, ssh, connect`. Also available on request:
   `boxes:resize`, `boxes:exec`, `boxes:snapshot`, `boxes:delete`.
   The response is `{ deviceCode, userCode, verificationUriComplete, interval, expiresIn }`.
2. Show `userCode` in the app, then open `verificationUriComplete` with
   `shell.openExternal`. The person signs in to the Cubicle Dashboard, picks the
   organization and selects **Authorize Ateam**. Approving needs the owner or admin role in
   that organization.
3. Poll `POST {API}/v1/auth/device/token` with `{ deviceCode }` every `interval` seconds,
   until `expiresIn` runs out. On success you receive
   `{ token, tokenType: "api_key", expiresAt, connection: { id, applicationId, org: { id, name }, permissions } }`.
4. Store `token` encrypted with Electron `safeStorage`, in the main process only. Never
   send it to the renderer. Store `connection` and `expiresAt` next to it.
5. Use `Authorization: Bearer <token>` for every Cubicle call. `GET /v1/me` returns
   `apiKey.connection` and the one organization in `orgs` (with `boxCreateAllowed`).

Ateam requests the default scopes plus `boxes:snapshot` (images) and `boxes:delete`
(a task's Box is removed with its task, and a Box whose setup failed is removed at
once). After saving the approved
connection, the desktop checks for its reusable image and starts a build when one
is missing. This runs in the main process while the connection form displays progress.

An agent can start the same flow; the person still approves it in the browser.

## Error codes (`error.code` in the JSON body)

| Code                      | When                                 | Ateam does                                                   |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| `authorization_pending`   | Polling, not yet answered            | Keep polling                                                 |
| `access_denied`           | The person chose Cancel              | Show "Not connected", offer Connect again                    |
| `expired_token`           | 10 minutes without an answer         | Offer Connect again                                          |
| `invalid_grant`           | Code used or unknown                 | Start over                                                   |
| `connection_revoked`      | Revoked in the Dashboard (401)       | Delete the stored token, show "Reconnect Cubicle"            |
| `connection_expired`      | The 90-day key expired (401)         | Run the flow again; the same connection and Boxes are kept   |
| `insufficient_permission` | A route needs an ungranted permission (403); `detail.required` names it | Ask to reconnect with that scope |
| `api_key_not_allowed`     | A route applications can never use   | Bug in Ateam; do not retry                                   |

## Cubicle API and tunnel calls

| Equivalent CLI operation                | What Ateam calls with the connection token                               |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `cubicle whoami --json`                   | `GET /v1/me`. The organization is fixed: `connection.org.name`.         |
| `cubicle boxes list --org X --json`       | `GET /v1/orgs/{org}/boxes`                                             |
| `cubicle boxes create ...`                | `POST /v1/orgs/{org}/boxes` `{ name, vcpus, memoryMiB, diskGiB }` with an `Idempotency-Key` header; poll `GET /v1/boxes/{id}` |
| `cubicle boxes start`                     | `POST /v1/boxes/{id}/start`                                            |
| `cubicle keys list/add`                   | `GET /v1/keys`, `POST /v1/keys` `{ publicKey: "ssh-ed25519 ..." }`      |
| `cubicle connect`, `cubicle ssh-config`   | The same CLI commands with env `CB_CLI_API_URL={API}` and `CB_CLI_API_KEY={token}` |

The tunnel needs Cubicle's root network helper. Ateam installs it, and reinstalls it
when it stops answering, by running the bundled CLI's `scripts/tunnel.sh install`
behind a macOS administrator prompt. It only prompts while a person is waiting for
a Box, never from a background reconnect. `cubicle tunnel status` reports
`installed` even when the helper is not running, so Ateam decides from
`cubicle connect` itself.

## Behaviour to know

- Ateam acts as **its own account** in the organization (shown as `ORG/ateam-xxxxxx`), not
  as the person. It manages only the Boxes it created. The person's own CLI login is not
  granted those Boxes automatically.
- A connection is bound to one organization. To use another organization,
  connect again and choose it.
- Each Mac that connects gets its own key; connecting again does not log out other Macs.
- Revoking (Dashboard → Account → Connected applications) cuts off API access and open
  tunnels immediately. Boxes stay in the organization.

## UI states

Not connected (**Connect Cubicle** button) → Waiting for browser (shows the code, has
Cancel and "Open browser again") → Connected (organization, permissions, expiry,
**Disconnect**) → Reconnect needed (revoked, expired or missing permission).
**Disconnect** deletes the stored token locally. To revoke the connection in
Cubicle, use **Account → Connected applications** in the Dashboard.

## Verification

Connect through the browser against staging. Create a Box in the approved organization and
reach it over SSH through the tunnel. Check that revoking in the Dashboard puts Ateam in the
reconnect state.
