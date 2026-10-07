# Synced Lyrics source

`src/extensions/aurora-lyrics.js` is the script injected into YouTube Music. Edit
the numbered `.jsfrag` files here, then run:

```sh
node scripts/build-aurora-lyrics.mjs
node --check src/extensions/aurora-lyrics.js
```

The build concatenates the fragments without changing their bytes. They share
the original IIFE scope, so declarations and call order stay as they were. The
fragments are not standalone JavaScript modules; check syntax on the generated
script. Use `node scripts/build-aurora-lyrics.mjs --check` to catch a stale build.

This layout keeps the extension's single script injection and its existing
`document.currentScript` URL behavior. When changing a function, edit its
fragment and rebuild rather than editing the generated script directly.
