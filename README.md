# Smart Sales Agent

A WhatsApp sales assistant made of several agents. It reads customer enquiries, checks your price list
(Excel or Zoho), asks suppliers for missing items on WhatsApp or email, adds your margin, sends the
quotation (after your approval) and follows up.

Built with TypeScript, Node.js, SQLite and Claude.

## The agents

| Agent | Job | Uses Claude? |
|---|---|---|
| **Coordinator** (`src/agents/coordinator.ts`) | Gets every message, works out what the customer wants (new enquiry, more details, yes to the quote, question, wants a person) and passes the work to the right agent | Yes |
| **WhatsApp Reception** (`reception.ts`) | Writes every reply to the customer in your tone and the customer's language | Yes |
| **Requirement Gatherer** (`gatherer.ts`) | Turns the chat into an item list with quantities, and asks for missing sizes or quantities | Yes |
| **Price & Stock** (`priceChecker.ts`) | Finds each item in the Excel or Zoho price list and checks stock | Yes, to pick the right match |
| **Supplier Enquiry** (`supplier.ts`) | Asks suppliers for items you don't have, on WhatsApp or email, and reads their prices from the reply | Yes, to read replies |
| **Pricing & Margin** (`pricing.ts`) | Adds your margin (by customer, category or default), rounding and VAT | **No**: plain code, so prices are always exact |
| **Estimate** (`estimate.ts`) | Writes the quotation and creates the estimate in Zoho when Zoho is connected | No |
| **Follow-up** (`followup.ts`) | Reminds customers who haven't answered a quote, and chases slow suppliers | Yes, to write the message |

The database (`src/db.ts`) is the agents' shared memory: customers, chats, enquiries, items, supplier requests and
drafts waiting for approval.

### How an enquiry flows

1. A customer messages your WhatsApp Business number. Meta sends it to the app's webhook.
2. **Coordinator** decides it is a new enquiry. **Requirement Gatherer** lists the items. If a size or quantity is
   missing, **Reception** asks for it.
3. **Price & Stock** matches each item to the price list.
4. Items not in the list, or short of stock, go to **Supplier Enquiry**, which messages your suppliers. Reception
   tells the customer you are confirming those items.
5. When suppliers reply (or after the waiting time you set), **Pricing & Margin** prices everything and
   **Estimate** writes the quotation, plus a Zoho estimate if Zoho is connected.
6. The quotation waits in the dashboard for your approval (you can edit it), then goes to the customer.
7. **Follow-up** reminds the customer if they don't answer. When they say yes, the enquiry is marked won, the Zoho
   estimate is marked accepted, and you get a WhatsApp alert.

If a customer asks for a person, or an agent hits a problem, the chat is handed to you: the agents stop replying
to that customer until you click **Let the agents continue** in the dashboard.

### Safety

- Customer and supplier messages are treated as information, never as instructions to the agents.
- Prices come from your price list, supplier replies and your margin rules, calculated in code. The Reception
  agent is told never to state a price, stock level or delivery date that it wasn't given.
- Costs and margins are never shown to customers.
- Webhook calls are checked with Meta's signature, and the dashboard needs a password.

## Try it on your computer (no WhatsApp needed)

You need [Node.js](https://nodejs.org) 22.13 or newer and a Claude API key from https://console.anthropic.com.

```bash
npm install
npm run sample-price-list      # creates data/price-list.xlsx with example items
cp .env.example .env           # then set DASHBOARD_PASSWORD and ANTHROPIC_API_KEY in .env
npm run build
node --env-file=.env --disable-warning=ExperimentalWarning dist/index.js
```

Open http://localhost:3000 (any user name, your dashboard password). In **Test chat**, send a message such as
"Hi, price for 50 pcs 4 inch PVC pipe and 20 elbows". Replies appear in the server window and in **Enquiries**;
the quotation appears in **Approvals**. Add a supplier under **Suppliers** to see supplier requests.

## Your price list

**Excel**: the first row must have column names. These are recognised (any one of each):

| Field | Column names |
|---|---|
| Item name (required) | Item Name, Name, Description, Product, Material |
| Code | Item Code, SKU, Code, Product Code, Part No |
| Category | Category, Group, Item Group, Type, Brand |
| Unit | Unit, UOM |
| Selling price | Selling Price, Price, Rate, Unit Price, Sale Price, MRP |
| Cost | Cost Price, Cost, Purchase Price, Buying Price |
| Stock | Stock, Qty, Quantity, Available, Stock on Hand, Balance |

Without a stock column, every item counts as available. Replace `data/price-list.xlsx` at any time; the app reads it
again when the file changes.

**Zoho**: set `CATALOG_SOURCE=zoho` and the `ZOHO_*` settings. Items, prices, purchase rates and stock are read
from Zoho Books or Zoho Inventory every 15 minutes. With the Zoho settings filled in, estimates are created in Zoho
even when the price list is in Excel.

## Margins and approval

In the dashboard's **Settings**:

- **Price basis**: use the price list's selling price when there is one, or always cost + margin.
  Supplier items are always cost + margin.
- **Margin %**: a default, plus optional margins per category and per customer number. The customer margin wins
  over the category margin, which wins over the default.
- **Rounding**, **VAT %**, **quote validity**, **follow-up hours** (for example `24, 72`), and how long to wait
  for suppliers.
- **Quotes wait for my approval**: on by default. Replies that ask questions or say "we are checking" are sent
  automatically; quotations wait for you.

## Going live on WhatsApp

1. Create a Meta Business account and a developer app with the WhatsApp product (see Meta's
   [Cloud API get-started guide](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started)).
2. Host the app somewhere that runs 24/7 with a public HTTPS address (Railway, Render, a VPS). The `Dockerfile`
   works on all of them. Keep `/app/data` on a persistent disk.
3. Fill in `WHATSAPP_ACCESS_TOKEN` (a permanent System User token), `WHATSAPP_PHONE_NUMBER_ID`,
   `WHATSAPP_APP_SECRET` and a `WHATSAPP_VERIFY_TOKEN` of your choice.
4. In the Meta app, under WhatsApp → Configuration, set the webhook URL to `https://YOUR-ADDRESS/webhook/whatsapp`,
   type the same verify token, and subscribe to **messages**.
5. Submit these two message templates in WhatsApp Manager (category: Utility). They are only used when the last
   message from that person is more than 24 hours old:
   - Follow-up, e.g. name `quote_followup`:
     `Hello {{1}}, just checking whether you had a chance to review our quotation {{2}}. Reply here if you need any changes.`
   - Supplier enquiry, e.g. name `supplier_price_request`:
     `Hello, please share your best price and availability for: {{1}}. Thank you, {{2}}.`

   Then set `WHATSAPP_FOLLOWUP_TEMPLATE` and `WHATSAPP_SUPPLIER_TEMPLATE` to their names.
6. Set `OWNER_PHONE` to your own number for alerts. Send any message from your phone to the business number once a
   day so alerts can reach you (WhatsApp's 24-hour rule).

## Suppliers by email

Fill in the `EMAIL_*` settings (for Gmail, use an app password; SMTP `smtp.gmail.com`, IMAP `imap.gmail.com`).
Suppliers with an email address and no recent WhatsApp chat are asked by email. The app checks the inbox every minute
and reads replies from known supplier addresses. It marks every unread email in that inbox as read, so use a mailbox
that is only for supplier quotes.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Runs the tests (Claude and WhatsApp are replaced by test doubles) |
| `npm run typecheck` | Checks the TypeScript |
| `npm run build` | Builds into `dist/` |
| `npm start` | Starts the built app (reads settings from the environment) |
| `npm run dev` | Starts with automatic reload while you change code |
