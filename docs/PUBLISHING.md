# Publishing Best IDE Agent

Dual publish: **Visual Studio Marketplace** (Entra OIDC) and **Open VSX** (`OVSX_PAT`).

Publisher id: `BestIDE` · Extension: `best-ide-agent`

## One-time setup

### Visual Studio Marketplace (Entra OIDC)

1. Create/verify publisher **BestIDE** at [Visual Studio Marketplace Manage](https://marketplace.visualstudio.com/manage).
2. In Microsoft Entra ID, create an app registration (or user-assigned managed identity) with a **federated credential** for this repo. Subject example:
   - `repo:abest-tz/best-ide:environment:marketplace`
3. Add that identity as a member of the Marketplace publisher.
4. In GitHub → Settings → Environments → `marketplace`, set:

| Name | Type | Purpose |
|------|------|---------|
| `AZURE_CLIENT_ID` | Variable or secret | Entra app / managed identity client ID |
| `AZURE_TENANT_ID` | Variable or secret | Entra tenant ID |

Workflow uses `permissions: id-token: write` and `azure/login` with `allow-no-subscriptions: true`, then:

```bash
npx @vscode/vsce publish --azure-credential --packagePath <vsix>
```

No `AZURE_CLIENT_SECRET` when using federated credentials. Azure DevOps Marketplace PATs retire Dec 1, 2026 — prefer OIDC.

### Open VSX

1. Create an Eclipse/Open VSX account and namespace/publisher **BestIDE**.
2. Create an access token at [open-vsx.org](https://open-vsx.org/).
3. Add GitHub repository secret:

| Name | Purpose |
|------|---------|
| `OVSX_PAT` | `npx ovsx publish <vsix> -p $OVSX_PAT` |

## Cut a release

```bash
npm run typecheck && npm run test && npm run coverage && npm run build
npm run vsix   # optional local smoke
gh release create v0.3.0 --generate-notes
```

Publishing runs on `release: published` via `.github/workflows/publish.yml`.

## Local publish helpers

```bash
npm run publish:marketplace   # requires az login + Marketplace membership
npm run publish:ovsx -- path/to/best-ide-agent-0.3.0.vsix
```
