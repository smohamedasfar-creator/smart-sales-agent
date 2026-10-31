# Going live: step by step

About an hour, done together. Keep **your phone with the WhatsApp Business app** next to you: Meta sends codes to it
and you scan a QR code with it.

## Before we start (5 minutes)

- [ ] Update the **WhatsApp Business app** on your phone to the latest version.
- [ ] Open **business.facebook.com** in your browser and check you can see your business (Meta Business account).
- [ ] Have a **payment card** ready: the server (about USD 5 a month), Claude usage, and possibly the Meta partner.
- Owner alerts (new quotes to approve, orders, new customers, a customer asking for a person) appear on the
  dashboard's **Approvals** page. No second WhatsApp number is needed. If you ever want them on WhatsApp as well, put
  a different number (not the business number) in `OWNER_PHONE`.

## 1. Claude key (5 minutes)

1. Go to **console.anthropic.com**, sign in, add a payment method and some credit (Billing).
2. **Settings → API keys → Create key**. Copy it; we put it on the server in step 2.

## 2. The server (15 minutes)

The app runs on a server that is on day and night, with an https address. **Render** (render.com) is simple and
works from the browser (Railway was closed to new sign-ups on 31 October 2026):

1. Sign up at render.com with your GitHub account. **New → Web Service → GitHub → smart-sales-agent**.
2. Name `smart-sales-agent`, region **Frankfurt**, branch `main`, language **Docker**, instance **Starter**
   (about USD 7 a month; the free plan sleeps and can't keep data).
3. **Environment variables**: `DASHBOARD_PASSWORD` (a strong password of your own), `ANTHROPIC_API_KEY` (step 1),
   `DATABASE_PATH` = `/app/data/sales-agent.sqlite`, `EXCEL_PATH` = `/app/data/price-list.xlsx`.
4. **Advanced → Add Disk**: mount path `/app/data`, 1 GB.
5. **Deploy**. When it's live, add `PUBLIC_URL` = the address Render shows (`https://….onrender.com`).
6. Open the address, log in with any user name and your password. **Settings → Price list → Upload** your stock list.
7. In **Test chat**, write as a customer ("Hi, I need 10 UGREEN HDMI cable"). The agents answer in Enquiries, and
   the quote waits in Approvals. Nothing goes to WhatsApp yet.

## 3. Choose a Meta partner (10 minutes)

Your existing number is connected through a Meta partner's sign-up screen ("Coexistence"). Ask the partner:

- Do you support **Coexistence** (keep the WhatsApp Business app on the same number)?
- Does the WhatsApp account stay in **my own Meta Business account**?
- Can I create a **permanent access token** (System User) to use the Cloud API from my own app?

All three must be yes. Note their monthly fee, if any.

## 4. Connect your number (20 minutes)

1. Start the partner's **Embedded Signup**: log in with Facebook, pick your business, choose
   **"Connect existing WhatsApp Business app"**, and **scan the QR code** with the WhatsApp Business app on your phone.
   Allow chat history to be shared if you want older chats in the app's records.
2. In **developers.facebook.com → your app → WhatsApp → API setup**, copy the **Phone number ID**.
3. In **business.facebook.com → Settings → System users**, create a system user with access to the WhatsApp account
   and generate a **permanent token** with `whatsapp_business_messaging` and `whatsapp_business_management`.
4. In **App settings → Basic**, copy the **App secret**.
5. On Railway, add `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, and a
   `WHATSAPP_VERIFY_TOKEN` you make up (any word). The app restarts.
6. In the Meta app, **WhatsApp → Configuration → Webhook**: the URL is shown in the dashboard's
   **Settings → Connections** (`https://…/webhook/whatsapp`); type the same verify token; **Verify and save**.
   Then **subscribe** to `messages` and `smb_message_echoes`.

## 5. First real test (10 minutes)

1. From another phone, send your business number a price request.
2. Check the dashboard: the enquiry appears, the agents reply, the quote waits in **Approvals**.
3. Reply once yourself from the WhatsApp Business app: the agents should step back in that chat
   (Enquiries → "Let the agents continue" hands it back).

## 6. Your settings (whenever you like)

- **Settings**: your TRN, VAT 5%, margins, customer levels and per-category percentages, first-order offer,
  personal contacts (family and friends), tone of replies, business information (address, delivery, payment terms).
- **Suppliers**: each supplier with its WhatsApp number or email and the **brands** it sells.
- Keep **"Quotes wait for my approval"** on for the first weeks.

## Later

- **Message templates** (WhatsApp Manager): needed for follow-ups and supplier requests more than 24 hours after the
  person's last message. Approval by Meta can take a day; the README has the wording.
- **Zoho**: when you want live stock and estimates in Zoho, the Connections card lists the keys.
- Open the WhatsApp Business app **at least every 14 days**, or Meta disconnects the number from the agents.
