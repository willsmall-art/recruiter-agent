// pages/api/ashby.js — server-side Ashby proxy, no CORS issues

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { endpoint, body, apiKey } = req.body;
  if (!endpoint) return res.status(400).json({ error: "Missing endpoint" });

  // Use key from env (preferred) or from request body (fallback for per-user keys)
  const key = process.env.ASHBY_API_KEY || apiKey;
  if (!key) return res.status(400).json({ error: "No Ashby API key provided" });

  try {
    const credentials = Buffer.from(key + ":").toString("base64");
    const ashbyRes = await fetch(`https://api.ashbyhq.com/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${credentials}`,
      },
      body: JSON.stringify(body || {}),
    });

    const data = await ashbyRes.json();
    return res.status(ashbyRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
