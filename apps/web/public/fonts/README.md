# Self-hosted fonts

The app ships **IBM Plex Mono** (display) and **Inter** (body) self-hosted to keep
NEXA offline-installable as a PWA. Both are SIL OFL — redistribution OK.

## Files expected (woff2, latin subset, weights 400/500/600)

```
IBMPlexMono-Regular.woff2
IBMPlexMono-Medium.woff2
IBMPlexMono-SemiBold.woff2
Inter-Regular.woff2
Inter-Medium.woff2
Inter-SemiBold.woff2
```

## Provisioning

These are NOT committed to git (`*.woff2` ignored by the workspace `.gitignore`
when binary). Fetched at install time by the Dockerfile build step OR provisioned
on the toolbox VPS at `/opt/neobank/fonts/` and bind-mounted into the web container.

For local dev, run:

```bash
# from apps/web/
node scripts/fetch-fonts.mjs
```

Sources:
- IBM Plex Mono — https://github.com/IBM/plex (`packages/plex-mono/fonts/complete/woff2/IBMPlexMono-{Regular,Medium,SemiBold}.woff2`)
- Inter — https://github.com/rsms/inter/releases (latest `Inter-3.x.zip` → `extras/woff2/Inter-{Regular,Medium,SemiBold}.woff2`)

Until the fetch script runs, the `@font-face` declarations 404 silently and
the OS-stack fallback (`ui-monospace` / `system-ui`) renders. Visual fidelity
suffers but functionality is preserved.
