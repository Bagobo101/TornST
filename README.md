# Torn Stock Alerts

Torn Stock Alerts is an unofficial browser companion for the game Torn. It tracks stock prices, lets you configure price and percentage alerts, and includes portfolio, comparison, and price-history tools. It only reads game data; it does not trade or make changes in Torn.

## Use the app

The frontend is a static site with no build step. Open `index.html` through a local web server, or publish the repository's static files to an HTTPS web host. HTTPS is required for browser notifications, push alerts, and some app features.

Add your Torn API key in the app. A Public Only key is enough for prices, bank rates, and alerts; holdings and your player-name greeting require the corresponding optional key selections. The key entered in the app is stored in that browser and sent to Torn's API.

## Background alerts (optional)

The Cloudflare Worker checks watched thresholds every five minutes and can send push notifications while the app is closed. It is optional. The app ships with a built-in shared Worker URL, and each device authenticates with its own auto-generated secret, so users do not need to deploy anything. The Worker is multi-user: every device has its own record (watchlist and push subscription), registrations are capped by `MAX_USERS`, and records inactive for 90 days are removed. To run your own instead, deploy it to your Cloudflare account; it needs a KV namespace and the secrets `TORN_API_KEY`, `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. `BACKGROUND_TOKEN` is now optional and only keeps a pre-existing single-user setup working (its data is migrated automatically).

Install dependencies and check the Worker syntax:

```sh
npm install
npm run check:worker
```

Before deploying, configure the KV namespace ID, `APP_ORIGIN`, and `VAPID_SUBJECT` in `wrangler.toml`. Follow the full [background alerts setup guide](docs.html#background-alerts) to generate keys, configure secrets, deploy the Worker, and connect it in the app.

Available Worker commands:

```sh
npm run worker:dev
npm run worker:deploy -- --secrets-file .env.production
```

Keep `.env.production` and all API and push secrets private; never commit them. The Worker stores its watchlist and push subscriptions in your Cloudflare KV namespace.

## Data and privacy

The app can optionally use a shared Firebase pool for anonymous stock price history and fetch historical prices from Tornsy when requested. Read [Docs & Terms](docs.html) for details about data handling, API-key usage, limitations, and the terms of use.

## License

Licensed under the GNU General Public License, version 3 only. See [COPYING](COPYING).