# Stella Outlook Add-in

V1 Outlook task pane for the current message or compose draft. The package uses
Bun for build and local HTTPS serving; there is no Vite layer.

## Local Test

1. Start Stella API and web in separate terminals:

   ```sh
   bun run dev:api
   bun run dev:web
   ```

2. Sign in at `http://localhost:3000`.

3. Create the HTTPS certificate once:

   ```sh
   bun --filter @stll/outlook cert
   ```

   On macOS, trust it if Outlook or the browser warns:

   ```sh
   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain apps/outlook/.certs/localhost-cert.pem
   ```

4. Start the add-in:

   ```sh
   bun --filter @stll/outlook dev
   ```

   The Bun dev server rebuilds `src/` and `public/` changes into
   `apps/outlook/dist`.

5. Browser smoke test: open `https://localhost:3002/taskpane.html`.

6. Outlook sideload:
   - Open Outlook on the web.
   - Go to **Get add-ins** / **My add-ins**.
   - Choose **Add a custom add-in**.
   - Select **Add from file**.
   - Pick `apps/outlook/manifest.xml`.
   - Open an email or compose draft and click **Stella** in the ribbon.

The dev server proxies `/api` to `http://localhost:3001`, so the task pane can
use the normal Stella session after browser sign-in.
