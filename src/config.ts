// All settings come from environment variables (see .env.example).
// Business rules that the owner changes often (margins, follow-up timing, approval)
// live in the database instead, so they can be edited from the dashboard.

export interface Config {
  port: number;
  publicUrl: string;
  dashboardPassword: string;
  databasePath: string;

  anthropicModel: string;

  whatsapp: {
    accessToken: string;
    phoneNumberId: string;
    /** The WhatsApp Business Account ID ("Messaging account ID"), used by the dashboard's connection check. */
    businessAccountId: string;
    appSecret: string;
    verifyToken: string;
    apiVersion: string;
    followupTemplate: string;
    followupTemplateLanguage: string;
    supplierTemplate: string;
    supplierTemplateLanguage: string;
  };

  catalogSource: "excel" | "zoho";
  excel: {
    path: string;
    sheet: string;
  };

  zoho: {
    enabled: boolean;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    organizationId: string;
    /** "books" or "inventory": which Zoho app holds the items and estimates. */
    app: "books" | "inventory";
    /** Data centre domain, e.g. "zoho.com", "zoho.in", "zoho.eu", "zoho.com.au". */
    domain: string;
  };

  email: {
    enabled: boolean;
    from: string;
    smtpHost: string;
    smtpPort: number;
    imapHost: string;
    imapPort: number;
    user: string;
    password: string;
  };
}

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export function loadConfig(): Config {
  const catalogSource = env("CATALOG_SOURCE", "excel");
  if (catalogSource !== "excel" && catalogSource !== "zoho") {
    throw new Error(`CATALOG_SOURCE must be "excel" or "zoho", not "${catalogSource}"`);
  }
  const zohoApp = env("ZOHO_APP", "books");
  if (zohoApp !== "books" && zohoApp !== "inventory") {
    throw new Error(`ZOHO_APP must be "books" or "inventory", not "${zohoApp}"`);
  }

  return {
    port: Number(env("PORT", "3000")),
    publicUrl: env("PUBLIC_URL", "http://localhost:3000"),
    dashboardPassword: env("DASHBOARD_PASSWORD"),
    databasePath: env("DATABASE_PATH", "data/sales-agent.sqlite"),

    anthropicModel: env("ANTHROPIC_MODEL", "claude-opus-5-5"),

    whatsapp: {
      accessToken: env("WHATSAPP_ACCESS_TOKEN"),
      phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"),
      businessAccountId: env("WHATSAPP_BUSINESS_ACCOUNT_ID"),
      appSecret: env("WHATSAPP_APP_SECRET"),
      verifyToken: env("WHATSAPP_VERIFY_TOKEN"),
      apiVersion: env("WHATSAPP_API_VERSION", "v23.0"),
      followupTemplate: env("WHATSAPP_FOLLOWUP_TEMPLATE"),
      followupTemplateLanguage: env("WHATSAPP_FOLLOWUP_TEMPLATE_LANGUAGE", "en"),
      supplierTemplate: env("WHATSAPP_SUPPLIER_TEMPLATE"),
      supplierTemplateLanguage: env("WHATSAPP_SUPPLIER_TEMPLATE_LANGUAGE", "en"),
    },

    catalogSource,
    excel: {
      path: env("EXCEL_PATH", "data/price-list.xlsx"),
      sheet: env("EXCEL_SHEET"),
    },

    zoho: {
      enabled: Boolean(env("ZOHO_REFRESH_TOKEN")),
      clientId: env("ZOHO_CLIENT_ID"),
      clientSecret: env("ZOHO_CLIENT_SECRET"),
      refreshToken: env("ZOHO_REFRESH_TOKEN"),
      organizationId: env("ZOHO_ORGANIZATION_ID"),
      app: zohoApp,
      domain: env("ZOHO_DOMAIN", "zoho.com"),
    },

    email: {
      enabled: Boolean(env("EMAIL_USER")),
      from: env("EMAIL_FROM", env("EMAIL_USER")),
      smtpHost: env("EMAIL_SMTP_HOST"),
      smtpPort: Number(env("EMAIL_SMTP_PORT", "465")),
      imapHost: env("EMAIL_IMAP_HOST"),
      imapPort: Number(env("EMAIL_IMAP_PORT", "993")),
      user: env("EMAIL_USER"),
      password: env("EMAIL_PASSWORD"),
    },
  };
}
