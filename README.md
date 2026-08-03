# Azure DevOps Work Items for Obsidian

Reference Azure DevOps work items inside your notes the same way you do in an Azure DevOps
comment box, where `#` links a work item:

```text
Blocked on az#login  →  pick "Fix login bug"  →  [B#1234 Fix login bug](https://dev.azure.com/contoso/Web/_workitems/edit/1234)
```

The note keeps a plain markdown link, so it stays readable and portable. While the plugin is
active that link renders as a rich chip showing the work item type, id, title and state.

## Features

- **Inline autocomplete.** Type `az#` (configurable) followed by an id or part of a title.
  Searching is debounced and runs against the Azure DevOps work item tracking API.
- **Rich chips** in both Reading view and Live Preview, coloured with the real work item type
  and state colours from your project's process template.
- **Hover card** with assignee, iteration, area, tags and a description snippet.
- **Command palette picker** — *Insert work item reference* — for when you would rather not type
  the trigger.
- **Paste conversion.** Paste an Azure DevOps work item URL and it becomes a reference.
- **Graceful degradation.** Chips fall back to the plain markdown link if the plugin is disabled,
  you are offline, or the work item is not accessible.
- **Three ways to authenticate.** A personal access token, an interactive Microsoft Entra sign-in
  (desktop *and* mobile, no stored secret), or your existing `az login` session on desktop.
- Works with **Azure DevOps Services** and **Azure DevOps Server** (on-premises collections).

## Installation

### From the community catalogue

Once the plugin is published, open *Settings → Community plugins → Browse*, search for
**Azure DevOps Work Items**, install it and enable it.

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/fvandillen/obsidian-azure-devops-workitems/releases/latest),
   or build them yourself (see [Development](#development)).
2. Copy those three files into `<your-vault>/.obsidian/plugins/azure-devops-workitems/`.
3. Reload Obsidian and enable **Azure DevOps Work Items** in *Settings → Community plugins*.

### Beta releases

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) and add
`fvandillen/obsidian-azure-devops-workitems` as a beta plugin to track pre-release builds.

## Setup

1. Open *Settings → Azure DevOps Work Items* and set the **Organization URL**
   (`https://dev.azure.com/contoso`, or `https://tfs.local/tfs/DefaultCollection` for
   Azure DevOps Server) and your **Default project**.
2. Choose an authentication method — see below.
3. Press **Test** to confirm the connection.

## Authentication

| Method | Works on | Needs | Notes |
| --- | --- | --- | --- |
| Personal access token | Desktop + mobile, Services + Server | Nothing | Simplest. The only option for Azure DevOps Server. |
| Microsoft Entra sign-in | Desktop + mobile, Services only | An app registration | No long-lived secret in the vault. |
| Azure CLI session | Desktop only, Services only | `az login` | Nothing to configure or store. |

### Personal access token

Create one in Azure DevOps under *User settings → Personal access tokens → New token*. It only
needs the **Work Items → Read** scope. Paste it into the *Personal access token* field.

> [!WARNING]
> The token is stored in plain text in `.obsidian/plugins/azure-devops-workitems/data.json`,
> like every other Obsidian plugin credential. Do not commit that file, and prefer a token with
> read-only work item scope and a short expiry.

### Microsoft Entra sign-in

Authorization code flow with PKCE. The browser returns to Obsidian through an `obsidian://` URL,
so this works on mobile too. Only the refresh token is stored — never a password, and never a
credential you have to rotate by hand.

It needs a Microsoft Entra app registration. Ask an administrator if you cannot create one
yourself. In the [Azure portal](https://portal.azure.com) → *Microsoft Entra ID* →
*App registrations* → *New registration*:

1. **Name**: anything, e.g. `Obsidian Azure DevOps`.
2. **Supported account types**: *Accounts in this organizational directory only* is enough.
3. **Redirect URI**: select **Public client/native (mobile & desktop)** and enter
   `obsidian://azdo-auth`. Custom schemes are allowed for this platform type — an `https` URL is
   only required for the *Web* and *Single-page application* types.
4. After creating it, under *Authentication* → *Advanced settings*, set
   **Allow public client flows** to *Yes*.
5. Under *API permissions* → *Add a permission* → *Azure DevOps* → *Delegated permissions* →
   **user_impersonation**, then grant consent.

Then copy the **Application (client) ID** into the plugin settings and press **Sign in**. Use the
tenant GUID as *Directory (tenant) ID* if the registration is single-tenant; otherwise leave it as
`organizations`.

If sign-in fails complaining about the scope, change the *Scope* setting to
`499b84ac-1321-427f-aa17-267ca6975798/user_impersonation offline_access`.

### Azure CLI session

Reuses the token from `az login`, so there is nothing to register or store. Requires the
[Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) and only works on desktop —
Obsidian mobile cannot run external programs, so the option is hidden there.

Run `az login` once, then select *Azure CLI session*. If the plugin cannot find `az` (desktop apps
launched from Finder or the Start menu often have a minimal `PATH`), set the full path in
*Azure CLI path*. If your organization enforces conditional access on Azure DevOps, you may need
`az login --scope 499b84ac-1321-427f-aa17-267ca6975798/.default`.

## Usage

| Action | How |
| --- | --- |
| Insert a reference | Type `az#` then an id or title fragment, pick with `↑` `↓` and `↵` |
| Insert without typing the trigger | Command palette → *Insert work item reference* |
| See details | Hover a chip |
| Open in Azure DevOps | Click a chip |
| Convert a copied URL | Paste it into a note |
| Force a data refresh | Command palette → *Refresh work item data* |
| Sign in with Microsoft Entra | Command palette → *Sign in* |
| Forget the stored credential | Command palette → *Sign out* |

Editing a chip is the same as editing any Obsidian link: move the cursor into it in Live Preview
and it unfolds back into markdown.

## Settings reference

**Connection**

- *Organization URL*, *Default project*, *Authentication*, *Test connection*. The fields below
  *Authentication* change with the selected method.

**Autocomplete**

- *Trigger prefix* — defaults to `az#`. Avoid a bare `#`, which collides with Obsidian tags.
- *Maximum suggestions* — 3–25 results.
- *Search scope* — the default project or the whole organization.
- *Before you type anything* — recently changed items, items assigned to you, or nothing.
- *Link label* — template for the inserted markdown label. Placeholders: `{id}`, `{title}`,
  `{type}`, `{typeAbbrev}`, `{state}`. Default `{typeAbbrev}#{id} {title}` produces
  `B#1234 Fix login bug`.

**Appearance**

- Toggle chips per view (reading / live preview), the type icon, title, state and assignee.
- *Strike through completed work items*, *Maximum title length*, *Hover preview*.

**Advanced**

- *Convert pasted work item URLs*, *Cache lifetime*, *Clear cache*.

## How references are stored

A reference is an ordinary markdown link, for example:

```markdown
[B#1234 Fix login bug](https://dev.azure.com/contoso/Web/_workitems/edit/1234)
```

The plugin recognises any work item URL belonging to your configured organization, including bare
URLs, `?id=` style URLs, legacy `*.visualstudio.com` URLs and on-premises collection URLs. Links
that point at a different organization are left untouched.

## How data is fetched

Search uses WIQL (`POST _apis/wit/wiql`) and then batches the resulting ids through
`GET _apis/wit/workitems`, so a note with twenty references costs one request rather than twenty.
Ids are resolved at organization scope, so a reference keeps working after the work item is moved
to another project. Results are cached for the configured lifetime, and concurrent requests for the
same work item are de-duplicated. All requests go through Obsidian's `requestUrl`, which avoids
browser CORS restrictions. Personal access tokens are sent as HTTP basic auth, as Azure DevOps
expects; Microsoft Entra and Azure CLI sessions are sent as bearer tokens. A bearer token that
comes back rejected is discarded and re-acquired once before the error surfaces.

## Development

```bash
npm install
npm run dev     # watch build
npm run lint    # ESLint — must pass before a change is done
npm run build   # type check + production bundle
```

To develop against a real vault, symlink or copy the repository into
`<vault>/.obsidian/plugins/azure-devops-workitems/`.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Azure DevOps returned a sign-in page" | The credential is missing, expired, or the PAT lacks *Work items (read)* |
| Chips stay as plain links | The link's organization does not match the configured *Organization URL*, or no credential is set yet |
| Autocomplete shows nothing | The trigger prefix does not match, or *Before you type anything* is set to *Nothing until I type* |
| Chips show `?` | The work item was deleted, or you have no access to its project |
| "Could not find the Azure CLI" | `az` is not on the app's `PATH` — set the full path in *Azure CLI path* |
| Sign-in reports `AADSTS50011` | The redirect URI in the app registration does not match exactly, or is not registered under *Mobile and desktop applications* |
| Sign-in reports a client secret is required | *Allow public client flows* is still set to *No* in the app registration |
| *Microsoft Entra sign-in* is missing from the dropdown | The organization URL is not `dev.azure.com` or `*.visualstudio.com`; Azure DevOps Server only supports PATs |

## License

MIT
