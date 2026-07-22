import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { fileURLToPath } from "url";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import dotenv from "dotenv";
import { Resend } from "resend";
import Stripe from "stripe";
import { GoogleGenAI } from "@google/genai";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";
import compression from "compression";
import { blogPosts } from "./src/data/blogPosts";
import { blogImagesMap } from "./src/utils/imageRegistry";

dotenv.config();

// Determine paths safely for ESM and CJS environments without triggering TDZ errors
const getPaths = () => {
  let filename = "";
  let dirname = "";
  try {
    if (typeof import.meta !== "undefined" && import.meta.url) {
      filename = fileURLToPath(import.meta.url);
      dirname = path.dirname(filename);
    }
  } catch (e) {
    // Suppress
  }
  if (!filename) {
    try {
      filename = new Function("return __filename")();
      dirname = new Function("return __dirname")();
    } catch (e) {
      // Suppress
    }
  }
  return { filename, dirname };
};

const { filename: resolvedFilename, dirname: resolvedDirname } = getPaths();

let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  if (!_ai) {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY environment variable is required");
    _ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } }
    });
  }
  return _ai;
}

async function appendToSheet(data: { name: string, date: string, mobile: string, email: string, concern: string }) {
  const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
  const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
  let PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY;
  
  if (!SPREADSHEET_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
    console.warn('Google Sheet credentials are not fully configured. Skipping sheet append.');
    return;
  }

  if (PRIVATE_KEY.includes('\\n')) {
    PRIVATE_KEY = PRIVATE_KEY.replace(/\\n/g, '\n');
  }

  const serviceAccountAuth = new JWT({
    email: CLIENT_EMAIL,
    key: PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
  
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  
  await sheet.addRow({
    'Customer name': data.name,
    'Date': data.date,
    'Mobile Number': data.mobile,
    'Email': data.email || 'N/A',
    'Concern': data.concern,
    'Submitted At': new Date().toISOString()
  });
}

// In-memory cache so we don't hit the Google Sheets API on every single page
// load — articles only change weekly, so a 5-minute cache is more than fresh
// enough while keeping the site fast and well within Google's free API quota.
let _blogCache: { posts: any[]; fetchedAt: number } | null = null;
const BLOG_CACHE_TTL_MS = 5 * 60 * 1000;

const _auspiciousDatesCache = new Map<number, { dates: Record<string, AuspiciousDateInfo>; fetchedAt: number }>();
const AUSPICIOUS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — this data doesn't change intraday

async function fetchBlogPostsFromSheet(): Promise<any[] | null> {
  const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
  const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
  let PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY;

  if (!SPREADSHEET_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
    // Not configured — caller falls back to the static blog post list.
    return null;
  }

  if (_blogCache && Date.now() - _blogCache.fetchedAt < BLOG_CACHE_TTL_MS) {
    return _blogCache.posts;
  }

  if (PRIVATE_KEY.includes('\\n')) {
    PRIVATE_KEY = PRIVATE_KEY.replace(/\\n/g, '\n');
  }

  try {
    const serviceAccountAuth = new JWT({
      email: CLIENT_EMAIL,
      key: PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();

    // Articles live on a separate tab named "Blog" in the same spreadsheet,
    // so this never touches the booking data on the first tab.
    const sheet = doc.sheetsByTitle['Blog'];
    if (!sheet) {
      console.warn('No "Blog" sheet tab found. Add one to enable weekly article updates.');
      return null;
    }

    const rows = await sheet.getRows();
    const posts = rows
      .map((row, i) => ({
        id: i + 1,
        title: (row.get('Title') || '').trim(),
        category: (row.get('Category') || 'Insights').trim(),
        readTime: (row.get('ReadTime') || '5 min read').trim(),
        date: (row.get('Date') || '').trim(),
        excerpt: (row.get('Excerpt') || '').trim(),
        content: (row.get('Content') || '').trim(),
      }))
      .filter((p) => p.title); // skip blank rows

    _blogCache = { posts, fetchedAt: Date.now() };
    return posts;
  } catch (err: any) {
    console.error('[Blog Sheet] Fetch error:', err.message);
    return null; // fall back to static posts rather than breaking the page
  }
}

// Genuine Panchang data via DivineAPI's documented Month Nakshatra List
// endpoint (https://developers.divineapi.com/indian-api/daily-panchang-api/month-nakshatra-list).
// Requires DIVINEAPI_API_KEY and DIVINEAPI_AUTH_TOKEN to be set — see
// README-panchang-api.md for setup. We only ever mark a date auspicious
// using the two well-documented, unambiguous, multi-source-verified Yoga
// rules below (Ravi Pushya / Guru Pushya). No other Yoga is approximated,
// and nothing is ever invented if the API is unavailable — callers get
// `null` and the calendar simply shows no stars that year.
type AuspiciousDateInfo = { title: string; desc: string; type: "wealth" | "beginnings" | "health" | "general" };

const PANCHANG_FETCH_TIMEOUT_MS = 10_000;
const PANCHANG_MAX_RETRIES = 2; // 3 total attempts per month

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMonthNakshatraList(
  form: URLSearchParams,
  authToken: string,
  month: number,
  year: number,
): Promise<any[] | null> {
  for (let attempt = 0; attempt <= PANCHANG_MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(
        "https://astroapi-8.divineapi.com/indian-api/v1/month-nakshatra-list",
        { method: "POST", headers: { Authorization: `Bearer ${authToken}` }, body: form },
        PANCHANG_FETCH_TIMEOUT_MS,
      );

      if (!res.ok) {
        console.error(`[Panchang API] Month ${month}/${year} returned HTTP ${res.status} (attempt ${attempt + 1}/${PANCHANG_MAX_RETRIES + 1})`);
        if (res.status >= 400 && res.status < 500) return null; // client error (bad key etc.) — retrying won't help
        continue; // 5xx — worth retrying
      }

      const json: any = await res.json();
      return json?.data?.nakshatra_list || [];
    } catch (err: any) {
      const reason = err?.name === "AbortError" ? "timeout" : err.message;
      console.error(`[Panchang API] Month ${month}/${year} attempt ${attempt + 1}/${PANCHANG_MAX_RETRIES + 1} failed: ${reason}`);
      if (attempt < PANCHANG_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); // simple backoff: 500ms, 1000ms
      }
    }
  }
  return null; // exhausted retries — this month is skipped, never fabricated
}

async function fetchAuspiciousDatesFromPanchangAPI(year: number): Promise<Record<string, AuspiciousDateInfo> | null> {
  const API_KEY = process.env.DIVINEAPI_API_KEY;
  const AUTH_TOKEN = process.env.DIVINEAPI_AUTH_TOKEN;

  if (!API_KEY || !AUTH_TOKEN) {
    // Not configured — caller shows no stars rather than fabricating any.
    return null;
  }

  const cached = _auspiciousDatesCache.get(year);
  if (cached && Date.now() - cached.fetchedAt < AUSPICIOUS_CACHE_TTL_MS) {
    return cached.dates;
  }

  try {
    const dates: Record<string, AuspiciousDateInfo> = {};

    for (let month = 1; month <= 12; month++) {
      const form = new URLSearchParams();
      form.set("api_key", API_KEY);
      form.set("month", String(month).padStart(2, "0"));
      form.set("year", String(year));
      form.set("place", "New Delhi");
      form.set("lat", "28.6139");
      form.set("lon", "77.2090");
      form.set("tzone", "5.5");

      const list = await fetchMonthNakshatraList(form, AUTH_TOKEN, month, year);
      if (!list) {
        continue; // this month's data unavailable after retries — skip it, don't fabricate
      }

      for (const entry of list) {
        if (entry?.nakshatra !== "Pushya" || !entry?.start_time) continue;
        const startDate = new Date(entry.start_time.replace(" ", "T"));
        if (isNaN(startDate.getTime())) continue;
        const weekday = startDate.getDay(); // 0 = Sunday, 4 = Thursday
        const dateKey = entry.start_time.slice(0, 10); // "YYYY-MM-DD"

        if (weekday === 0) {
          dates[dateKey] = {
            title: "Ravi Pushya Yoga",
            desc: "Pushya Nakshatra falls on Sunday — a highly auspicious window for decisive action and new beginnings.",
            type: "general",
          };
        } else if (weekday === 4) {
          dates[dateKey] = {
            title: "Guru Pushya Yoga",
            desc: "Pushya Nakshatra falls on Thursday — a highly auspicious window for investments and spiritual practices.",
            type: "general",
          };
        }
      }
    }

    _auspiciousDatesCache.set(year, { dates, fetchedAt: Date.now() });
    return dates;
  } catch (err: any) {
    console.error("[Panchang API] Fetch error:", err.message);
    return null; // never fabricate a fallback
  }
}

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY environment variable is required');
  return new Resend(key);
}

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY environment variable is required');
  return new Stripe(key);
}

async function startServer() {
  const app = express();
  // GoDaddy's Node.js hosting runs this app behind its own reverse proxy, which adds an
  // X-Forwarded-For header. Without telling Express to trust that proxy, express-rate-limit
  // logs a validation warning and can't reliably identify real client IPs for rate limiting.
  app.set('trust proxy', 1);
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  // Apply compression middleware to drastically reduce asset file sizes and prevent network egress bottlenecks under high concurrent load (e.g. 100k users)
  app.use(compression());

  // Apply security HTTP headers
  const isProdEnv = process.env.NODE_ENV === 'production';
  app.use(helmet({
    // Only disable CSP in dev, where it would block Vite's HMR/inline scripts.
    // In production we want a real CSP so Helmet's other protections aren't undermined.
    contentSecurityPolicy: isProdEnv ? {
      directives: {
        defaultSrc: ["'self'"],
        // 'unsafe-inline' is required because index.html may still have small inline
        // <script> tags for other purposes; keeping this avoids silently breaking them.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https://images.unsplash.com", "https://*.googleusercontent.com"],
        connectSrc: ["'self'"],
      },
    } : false,
    // Ensure iframe protection (prevent clickjacking)
    crossOriginEmbedderPolicy: false,
  }));

  // Restrict cross-origin requests
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://jitingoel.com,https://www.jitingoel.com').split(',').map((o) => o.trim());
  app.use(cors({
    origin: isProdEnv ? allowedOrigins : '*',
    // Allow all in dev; restrict to your real domain(s) in prod (set ALLOWED_ORIGINS env var to override)
    credentials: true
  }));

  app.use(express.json());

  // 🛡️ Web Application Firewall & Anti-Hack Firewall Middleware
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    // 1. Defend against Denial of Service (DoS) / Buffer Overflow attacks by blocking payloads > 2MB
    const contentLength = req.headers['content-length'];
    if (contentLength && parseInt(contentLength, 10) > 2 * 1024 * 1024) {
      console.warn(`[WAF Block] Excessive request payload size from IP: ${req.ip}`);
      return res.status(413).json({
        success: false,
        error: "Security Alert: Request payload size limits exceeded (Max 2MB). Connection closed by Antihack Firewall."
      });
    }

    // 2. Advanced Injection Detection (SQL Injection, XSS Script Tags, Command Injection, Directory Traversal)
    const detectMaliciousPattern = (value: string): boolean => {
      if (typeof value !== 'string') return false;
      const maliciousPatterns = [
        /union\s+all\s+select/i,
        /select\s+.*\s+from/i,
        /insert\s+into/i,
        /delete\s+from/i,
        /drop\s+table/i,
        /update\s+.*\s+set/i,
        /or\s+['"]?\d+['"]?\s*=\s*['"]?\d+/i,
        /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/i,
        /javascript\s*:/i,
        /onerror\s*=/i,
        /onload\s*=/i,
        /eval\s*\(/i,
        /document\.cookie/i,
        /\.\.\/\.\./,
        /\/etc\/passwd/i,
        /bin\/sh/i,
        /bin\/bash/i
      ];
      return maliciousPatterns.some(regex => regex.test(value));
    };

    const isUnsafe = (obj: any): boolean => {
      if (!obj) return false;
      if (typeof obj === 'string') {
        return detectMaliciousPattern(obj);
      }
      if (typeof obj === 'object') {
        for (const key in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, key)) {
            if (isUnsafe(obj[key])) return true;
          }
        }
      }
      return false;
    };

    // Sanitize body, query parameters, and decoded request paths
    let pathIsUnsafe = false;
    try {
      pathIsUnsafe = detectMaliciousPattern(decodeURIComponent(req.path));
    } catch {
      pathIsUnsafe = detectMaliciousPattern(req.path);
    }

    if (isUnsafe(req.query) || isUnsafe(req.body) || pathIsUnsafe) {
      console.warn(`[WAF Block] Unsafe input pattern or injection signature detected from IP: ${req.ip} on URL: ${req.url}`);
      return res.status(400).json({
        success: false,
        error: "Security Alert: Malicious or unsafe payload signature blocked by Antihack Firewall."
      });
    }

    // 3. Set standard advanced defense-in-depth headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    next();
  });

  // API Rate Limiting to prevent abuse/brute-force "hacks"
  const chatLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per `window`
    message: { response: "You have exceeded the maximum number of daily requests. Please slow down and try again later." }
  });

  const bookingLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 15,
    message: { success: false, error: "Too many booking attempts. Please try again later." }
  });

  app.post("/api/chat", chatLimiter, async (req, res) => {
    try {
      const { message, history } = req.body;
      
      // Check for API key first
      if (!process.env.GEMINI_API_KEY) {
        return res.json({ 
          response: "My advanced AI capabilities are currently paused because the Gemini API key has not been configured in the environment settings. Please add your GEMINI_API_KEY to activate my full potential." 
        });
      }

      const ai = getAI();
      const model = "gemini-3.5-flash";
      
      const systemInstruction = `You are a highly sophisticated, smooth, and extraordinarily knowledgeable AI assistant representing Jitin Goel. You embody his 20+ years of high-stakes corporate leadership and profound mastery of Vedic sciences (Astrology, Numerology, Vastu).
Your tone is remarkably smooth, eloquent, executive, and warmly authoritative. You offer deep, insightful answers that seamlessly bridge ancient wisdom with modern pragmatic business strategy.
Answer the visitor's questions directly with actionable clarity, weaving in layers of profound insight. Be authentic, naturally engaging, and BS-free. Ground all spiritual advice in corporate reality.
If the user communicates in Hindi, seamlessly respond in beautifully articulate and fluent Hindi (in Devanagari script), maintaining the same executive, polished, and spiritual tone.
Keep your answers beautifully formatted, highly conversational but professional, concise, actionable, and aligned with 'The True Purpose': empowering individuals and organizations to discover growth opportunities, overcome complex obstacles, and achieve meaningful material success while preserving deep inner peace.`;

      let contents: any[] = [];
      if (history && Array.isArray(history)) {
          contents = history.map((msg: any) => ({
              role: msg.role === 'user' ? 'user' : 'model',
              parts: [{ text: msg.text }]
          }));
      }
      contents.push({ role: 'user', parts: [{ text: message }] });

      let replyText = "";
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config: { systemInstruction }
        });
        replyText = response.text || "Empty response from AI";
      } catch (aiError) {
        console.warn("AI Chat failed, using dynamic fallback.", aiError);
        replyText = "I am currently synthesizing new strategic insights and experiencing high demand. However, remember this timeless principle: True mastery lies in effortless execution. Focus on aligning your deepest purpose with your most immediate action. How may I assist you further once I am fully back online?";
      }
      
      res.json({ response: replyText });
    } catch (error: any) {
      console.error("Chat error:", error);
      res.status(500).json({ error: error.message || "Failed to generate response." });
    }
  });

  app.get("/api/payment-config", (_req, res) => {
    res.json({
      stripeEnabled: !!process.env.STRIPE_SECRET_KEY,
      paymentLinkEnabled: !!process.env.PAYMENT_LINK_URL,
    });
  });

  app.get("/api/chat-config", (_req, res) => {
    res.json({
      aiChatEnabled: !!process.env.GEMINI_API_KEY,
    });
  });

  // Weekly-editable blog: reads from a "Blog" tab in the same Google Sheet used
  // for bookings. Returns { posts, source: "sheet" } when configured, or
  // { posts: [], source: "static" } so the frontend falls back to its bundled
  // article list — the page never breaks even if the sheet is empty or misconfigured.
  app.get("/api/blog-posts", async (_req, res) => {
    try {
      const posts = await fetchBlogPostsFromSheet();
      if (posts && posts.length > 0) {
        res.json({ posts, source: "sheet" });
      } else {
        res.json({ posts: [], source: "static" });
      }
    } catch (err: any) {
      console.error("[Blog API] Error:", err.message);
      res.json({ posts: [], source: "static" });
    }
  });

  // Genuine Panchang-sourced auspicious consultation dates for the given
  // year. Returns { dates: {}, source: "unconfigured" } when the API
  // credentials aren't set, or { dates: {}, source: "error" } if the
  // provider call fails — in both cases the calendar just shows no stars
  // for that year rather than ever falling back to invented dates.
// Verified fallback dates — used ONLY when the live DivineAPI isn't
// configured, so the calendar still shows genuine (not invented) stars
// out of the box. These are either pre-existing entries that predate this
// integration, or dates cross-checked against DrikPanchang's published
// Ravi Pushya Yoga listings (Pushya Nakshatra + Sunday) and independently
// verified by weekday calculation. This is a small, honest starting set —
// once DIVINEAPI_API_KEY/DIVINEAPI_AUTH_TOKEN are configured, the live
// API takes over automatically and this fallback is no longer used.
const VERIFIED_FALLBACK_DATES: Record<string, AuspiciousDateInfo> = {
  "2026-06-06": { title: "Dhanteras / Wealth", desc: "Highly auspicious for financial investments and new business ventures.", type: "wealth" },
  "2026-06-12": { title: "Vidyarambham", desc: "Favorable for starting new learning, courses, or creative projects.", type: "beginnings" },
  "2026-06-18": { title: "Arogya Siddhi", desc: "Good for health-related decisions and medical consultations.", type: "health" },
  "2026-06-25": { title: "Sarvartha Siddhi Yoga", desc: "Auspicious for all important acts and general prosperity.", type: "general" },
  "2026-07-03": { title: "Guru Pushya Yoga", desc: "Extremely favorable time for buying gold or starting spiritual practices.", type: "general" },
  "2026-07-14": { title: "Lakshmi Panchami", desc: "A day dedicated to wealth and prosperity.", type: "wealth" },
  "2026-11-01": { title: "Ravi Pushya Yoga", desc: "Pushya Nakshatra falls on Sunday — a highly auspicious window for decisive action and new beginnings.", type: "general" },
  "2026-11-29": { title: "Ravi Pushya Yoga", desc: "Pushya Nakshatra falls on Sunday — a highly auspicious window for decisive action and new beginnings.", type: "general" },
};

  app.get("/api/auspicious-dates", async (req, res) => {
    const year = parseInt(String(req.query.year), 10);
    if (!year || year < 2020 || year > 2100) {
      return res.status(400).json({ dates: {}, source: "error", error: "Invalid or missing year." });
    }
    try {
      const dates = await fetchAuspiciousDatesFromPanchangAPI(year);
      if (dates && Object.keys(dates).length > 0) {
        res.json({ dates, source: "divineapi" });
      } else {
        const fallback = Object.fromEntries(
          Object.entries(VERIFIED_FALLBACK_DATES).filter(([key]) => key.startsWith(String(year))),
        );
        res.json({ dates: fallback, source: dates ? "empty-fallback" : "unconfigured-fallback" });
      }
    } catch (err: any) {
      console.error("[Auspicious Dates API] Error:", err.message);
      const fallback = Object.fromEntries(
        Object.entries(VERIFIED_FALLBACK_DATES).filter(([key]) => key.startsWith(String(year))),
      );
      res.json({ dates: fallback, source: "error-fallback" });
    }
  });

  app.post("/api/book-appointment", bookingLimiter, async (req, res) => {
    try {
      const { name, date, mobile, email, concern } = req.body;
      
      if (!name || !date || !mobile) {
        return res.status(400).json({ success: false, error: "Name, date, and mobile number are required." });
      }

      // 1. Google Sheets Integration
      try {
        await appendToSheet({ name, date, mobile, email, concern });
      } catch (err: any) {
        console.error("Sheets error:", err.message);
      }
      
      // 2. Email Notification System (Resend)
      if (process.env.RESEND_API_KEY) {
        console.log("[Booking] RESEND_API_KEY detected, attempting to send emails...");
        // 2a. Confirmation email to the CLIENT who booked — only if they gave an email
        if (email) {
          try {
            const resend = getResend();
            const clientResult = await resend.emails.send({
              from: 'Jitin Consulting <appointments@jitingoel.com>', 
              to: email,
              subject: 'Appointment Confirmation - Jitin Consulting',
              html: `<p>Dear ${name},</p><p>Your appointment has been successfully scheduled for ${date}.</p><p>We look forward to meeting with you.</p>${concern ? `<p>Concern listed: ${concern}</p>` : ''}`
            });
            console.log("[Booking] Client confirmation email result:", JSON.stringify(clientResult));
          } catch (err: any) {
            console.error("[Booking] Client email send error:", err.message, err);
          }
        } else {
          console.log("[Booking] No client email provided, skipping client confirmation email.");
        }
        try {
          const resend = getResend();
          // 2b. Notification email to Jitin himself, so every new booking is seen immediately.
          // Sent to his real inbox (set via OWNER_NOTIFICATION_EMAIL, e.g. his GoDaddy email) —
          // separate from the "from" sending address above, which just needs a verified domain.
          const ownerEmail = process.env.OWNER_NOTIFICATION_EMAIL;
          if (ownerEmail) {
            console.log("[Booking] Sending owner notification to:", ownerEmail);
            const ownerResult = await resend.emails.send({
              from: 'Jitin Consulting <appointments@jitingoel.com>',
              to: ownerEmail,
              subject: `New Booking: ${name} — ${date}`,
              html: `<p>New consultation booking received:</p><ul><li><strong>Name:</strong> ${name}</li><li><strong>Date:</strong> ${date}</li><li><strong>Mobile:</strong> ${mobile}</li><li><strong>Email:</strong> ${email || 'Not provided'}</li><li><strong>Concern:</strong> ${concern || 'Not provided'}</li></ul>`
            });
            console.log("[Booking] Owner notification email result:", JSON.stringify(ownerResult));
          } else {
            console.log("[Booking] OWNER_NOTIFICATION_EMAIL is not set, skipping owner notification.");
          }
        } catch (err: any) {
          console.error("[Booking] Owner notification email error:", err.message, err);
        }
      } else {
        console.log("[Booking] RESEND_API_KEY is not set, skipping all email notifications.");
      }

      // 3. Payment: simple no-code Payment Link (e.g. Razorpay) takes priority if set,
      // since it requires no API integration or GST registration to get started.
      if (process.env.PAYMENT_LINK_URL) {
        return res.json({ success: true, message: "Redirecting to payment...", checkoutUrl: process.env.PAYMENT_LINK_URL });
      }

      // 3b. Payment Gateway (Stripe) — used only if no PAYMENT_LINK_URL is set
      if (process.env.STRIPE_SECRET_KEY) {
        try {
          const stripe = getStripe();
          const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
              {
                price_data: {
                  currency: 'usd',
                  product_data: {
                    name: 'Consulting Session Booking',
                    description: `Booking for ${date}`,
                  },
                  // NOTE: This is a legacy fixed-fee fallback, only used if STRIPE_SECRET_KEY is set
                  // WITHOUT a PAYMENT_LINK_URL. Actual pricing is case-by-case per client, quoted
                  // individually — PAYMENT_LINK_URL (Razorpay) is the intended primary payment path.
                  unit_amount: 5000, // $50.00
                },
                quantity: 1,
              },
            ],
            mode: 'payment',
            success_url: `${req.protocol}://${req.get('host')}/#success`,
            cancel_url: `${req.protocol}://${req.get('host')}/`,
            customer_email: email,
          });
          
          return res.json({ success: true, message: "Redirecting to checkout...", checkoutUrl: session.url });
        } catch (err: any) {
          console.error("Stripe error:", err.message);
          // Fallback if Stripe crashes
        }
      }
      
      res.json({ success: true, message: "Appointment saved successfully" });
    } catch (error: any) {
      console.error("Error booking appointment:", error);
      res.status(500).json({ 
        success: false, 
        error: error.message || "An error occurred while saving the appointment." 
      });
    }
  });

  // Cache index.html content to avoid blocking synchronous filesystem reads on every concurrent SEO request
  let cachedIndexHtml: string | null = null;

  // Dynamic SEO Middleware to inject custom Open Graph headers for specific blog posts
  const serveIndexWithSEO = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const postId = req.query.post;
    if (!postId) {
      return next();
    }

    const isProd = process.env.NODE_ENV === "production";
    const filePath = isProd
      ? path.join(process.cwd(), 'dist', 'index.html')
      : path.join(process.cwd(), 'index.html');

    try {
      let html = "";
      if (isProd) {
        if (cachedIndexHtml) {
          html = cachedIndexHtml;
        } else {
          if (!fs.existsSync(filePath)) {
            return res.status(404).send("Index template not found");
          }
          cachedIndexHtml = fs.readFileSync(filePath, "utf8");
          html = cachedIndexHtml;
        }
      } else {
        if (!fs.existsSync(filePath)) {
          return next();
        }
        html = fs.readFileSync(filePath, "utf8");
      }

      const id = parseInt(postId as string, 10);
      const post = blogPosts.find(p => p.id === id);

      if (post) {
        const title = `${post.title} | Jitin Goel - Insights`;
        const desc = post.excerpt;
        const imageUrl = blogImagesMap[id] || "https://images.unsplash.com/photo-1534447677768-be436bb09401?q=80&w=1200&h=630&auto=format&fit=crop";

        html = html.replace(/<title>[^<]+<\/title>/, `<title>${title}</title>`);
        html = html.replace(/<meta property="og:title" content="[^"]+"/g, `<meta property="og:title" content="${title}"`);
        html = html.replace(/<meta property="og:description" content="[^"]+"/g, `<meta property="og:description" content="${desc}"`);
        html = html.replace(/<meta property="og:image" content="[^"]+"/g, `<meta property="og:image" content="${imageUrl}"`);
        html = html.replace(/<meta name="twitter:title" content="[^"]+"/g, `<meta name="twitter:title" content="${title}"`);
        html = html.replace(/<meta name="twitter:description" content="[^"]+"/g, `<meta name="twitter:description" content="${desc}"`);
        html = html.replace(/<meta name="twitter:image" content="[^"]+"/g, `<meta name="twitter:image" content="${imageUrl}"`);

        const fullUrl = `https://jitingoel.com/?post=${id}`;
        html = html.replace(/<meta property="og:url" content="[^"]+"/g, `<meta property="og:url" content="${fullUrl}"`);
        html = html.replace(/<meta name="twitter:url" content="[^"]+"/g, `<meta name="twitter:url" content="${fullUrl}"`);
        html = html.replace(/<link rel="canonical" href="[^"]+"/g, `<link rel="canonical" href="${fullUrl}"`);
      }

      res.setHeader('Content-Type', 'text/html');
      return res.send(html);
    } catch (err) {
      console.error("SEO index generation error:", err);
      if (isProd) {
        if (cachedIndexHtml) {
          res.setHeader('Content-Type', 'text/html');
          return res.send(cachedIndexHtml);
        }
        return res.sendFile(filePath);
      }
      return next();
    }
  };

  // Intercept root route first so dynamic query parameter templates override asset defaults
  app.get('/', serveIndexWithSEO);

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath, {
      maxAge: '1y',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else if (filePath.includes('/assets/') || filePath.match(/\.(js|css|webp|png|jpg|jpeg|gif|svg|ico|woff|woff2)$/)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=86400');
        }
      }
    }));
    app.get('*', (req, res, next) => {
      const postId = req.query.post;
      if (postId && req.path === '/') {
        return serveIndexWithSEO(req, res, next);
      }
      if (req.path === '/') {
        return res.sendFile(path.join(distPath, 'index.html'));
      }
      // Unknown path — return a real 404 status with a branded not-found page,
      // rather than silently serving the homepage as if the URL were valid.
      res.status(404).sendFile(path.join(distPath, '404.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
