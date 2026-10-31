# Smart Sales Agent

A WhatsApp sales assistant made of several agents. It reads customer enquiries, checks your price list
(Excel or Zoho), asks suppliers for missing items on WhatsApp or email, adds your margin, sends the
quotation (after your approval) and follows up.

Built with TypeScript, Node.js, SQLite and Claude.

## The agents

| Agent | Job | Uses Claude? |
|---|---|---|
| **Coordinator** (`src/agents/coordinator.ts`) | Gets every message, works out what the customer wants (new enquiry, more details, yes to the quote, question, wants a person) and passes the work to the right agent | Yes |
| **WhatsApp Reception** (`reception.ts`) | Writes every reply to the customer in your tone and the customer's language, like a polite senior salesperson | Yes |
| **Customer Details** (`details.ts`) | Gets a new customer's name, company, emirate and TRN from their messages | Yes |
| **Requirement Gatherer** (`gatherer.ts`) | Turns the chat into an item list with quantities, asks for missing quantities, and asks which model when several in your stock list fit | Yes |
| **Price & Stock** (`priceChecker.ts`) | Finds each item in the Excel or Zoho price list and checks stock | Yes, to pick the right match |
| **Brand agents** (`coordinator.ts`) | One per brand: send that brand's missing items to that brand's suppliers, and keep that brand's orders | No |
| **Supplier Enquiry** (`supplier.ts`) | Asks suppliers for items you don't have, on WhatsApp or email, and reads their prices from the reply | Yes, to read replies |
| **Pricing & Margin** (`pricing.ts`) | Margins (customer, item, category, brand, default), customer levels, the first-order price, rounding and VAT | **No**: plain code, so prices are always exact |
| **Estimate** (`estimate.ts`) | Writes the quotation, grouped by brand and addressed to the customer with both TRNs, and creates the estimate in Zoho when Zoho is connected | No |
| **Follow-up** (`followup.ts`) | Reminds customers who haven't answered a quote, and chases slow suppliers | Yes, to write the message |

The database (`src/db.ts`) is the agents' shared memory: customers, chats, enquiries, items, supplier requests and
drafts waiting for approval, and orders by brand.

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

## Workflow demo (in the browser, nothing to install)

`demo/index.html` is a one-page copy of the flow for trying it out: you chat as the customer and as the supplier, watch
each agent work, approve the quote, and move the clock forward to see follow-ups and supplier reminders. It uses the same
prompts, catalog search, pricing and quotation format as the app, with example items and suppliers instead of your Excel
or Zoho data. Published as a Claude artifact, its AI agents run on Claude; anywhere else they fall back to simple rules.
Nothing is sent to WhatsApp, suppliers or Zoho.

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

**Excel**: every sheet that has an item name column is read (or only the sheet named in `EXCEL_SHEET`). The column
names may be in any of the first 10 rows. These are recognised; where a field lists several, the first one with a
value on that row is used:

| Field | Column names |
|---|---|
| Item name (required) | Name, Item Name, Description, Item, Product Name, Product, Material |
| Code | SKU, Item Code, Code, Product Code, Part Number, Part No |
| Brand | Brand, Make, Manufacturer. Without one, a sheet named after a brand (e.g. `OPTERNA`) gives its name |
| Category | Category, Item Group, Group, Type, Product Category |
| Unit | Unit, UOM |
| Customer price | Customer Price, Selling Price, Price, Unit Price, MRP, Final Price, Rate |
| Reseller price | Reseller Price, Dealer Price, Trade Price, Wholesale Price |
| Cost | Cost, Cost Price, Purchase Price, Last Purchase |
| Stock | Available Qty, Stock, Qty, Quantity, Stock on Hand, Balance |
| Item margins | Margin Customer, Margin Re Seller (0.5 means 50%) |
| Remark | Remark, Notes, MOQ |

Sheets without an item name column (like a NOTES sheet) are skipped. Without a stock column, every item counts as
available. Replace `data/price-list.xlsx` at any time; the app reads it again when the file changes.

**Zoho**: set `CATALOG_SOURCE=zoho` and the `ZOHO_*` settings. Items, brands, prices, purchase rates and stock are read
from Zoho Books or Zoho Inventory every 15 minutes. With the Zoho settings filled in, estimates are created in Zoho
even when the price list is in Excel.

## Brands and suppliers

Each brand in the price list has its own agent. When items are short or not in the list, each brand's items go only to
the suppliers who sell that brand (**Suppliers → Brands**, e.g. `UGREEN, COMMANDO`). A supplier with no brands is the
fallback for brands that have no supplier of their own. Quotations are grouped by brand, and when a customer says yes
the quote becomes one order per brand, on the **Orders** tab, where each order's status is tracked (confirmed, ordered
from supplier, delivered, paid) and orders can be shown for one brand.

The customer is never told about suppliers: while prices are being collected, they hear that the quotation is being
prepared.

## Prices: margins and customer levels

In the dashboard's **Settings**:

- **Price basis**: use the price list's price when there is one, or always cost + margin. Supplier items are always
  cost + margin.
- **Margin %**, first one set wins: the customer's own (by number), the item's own (from the price list), the
  category's, the brand's, then the default.
- **Customer levels**: Level 1 gets the best price; each other level pays a percentage more (default Level 2 +4%,
  Level 3 +9%). A category can have its own percentage per level, e.g. `{"SWITCH": {"2": 3, "3": 8}}`. Set a
  customer's level on their enquiry. New customers start at a level you choose (Level 3).
- **First order**: a new customer's first order is priced at the first-order level (Level 1), without telling them;
  after it, their own level applies.
- **End customer or reseller** (on the customer): resellers get the price list's reseller price and reseller margin.
- **Rounding**, **VAT %**, **quote validity**, **follow-up hours** (for example `24, 72`), and how long to wait
  for suppliers.
- **Quotes wait for my approval**: on by default. A supplier price far from the price list (under 30% or over 3x),
  a zero price or a very large quantity always waits for you, even with approval off.

## New customers

A number that is not yet known is asked, once and politely, for its **name, company, emirate and TRN** (or to say it
is not VAT registered); a TRN that isn't 15 digits is asked for again. The quotation is prepared meanwhile but goes out
only once these are known (Settings: "Send quotes only after…"). It is addressed to the customer, with their TRN and
yours (Settings: Your TRN). You get an alert with the new customer's details and level.

## Personal contacts (family and friends)

Your WhatsApp number also gets messages from family, friends and other people you know. List them under
**Settings → Personal contacts** (one per line: number, name). The agents never read or answer their messages, and they
are taken off the customer list. A number is matched with or without the country code.

If someone who isn't on the list sends a message that looks personal (family news, an invitation, "how are you bro"),
the agents stay quiet and send you an alert, so you can add them to the list.

## Keeping your existing WhatsApp Business number ("coexistence")

You don't need a new number. Meta lets a number that already runs the **WhatsApp Business app** also be used by the
API (they call it *coexistence*): customers keep writing to the number they know, you keep the app on your phone with
your chats, and the agents answer through the API.

- The number must be on the **WhatsApp Business app** (not personal WhatsApp), on a recent app version.
- It is connected through Meta's **Embedded Signup**: you scan a QR code with the Business app on your phone. A Meta
  partner (BSP) or a Meta "Tech Provider" app runs this screen. Choose one that leaves the WhatsApp account in **your own
  Meta Business account** and lets you create a permanent access token, so this app can talk to the Cloud API directly.
- Up to 6 months of chat history can be brought over when connecting.
- **Open the WhatsApp Business app on your phone at least every 14 days**, or Meta disconnects the number from the API.
- Some app features stop on a coexistence number: broadcast lists, disappearing and view-once messages, live location.
  Group chats stay in the app only. Messages you send from the app stay free.
- In the Meta app's webhook settings, subscribe to **messages** and **smb_message_echoes**. The second one tells the
  agents when *you* reply from your phone: they then stay quiet in that chat until you press **Let the agents continue**
  in Enquiries, so a customer never gets two answers.

These details come from Meta partners' guides as of late 2026; check Meta's current coexistence page before you start.

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
