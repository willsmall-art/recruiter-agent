// pages/api/ashby.js
// This runs server-side — no CORS issues, API key stays safe

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { endpoint, body } = req.body;

  if (!endpoint) {
    return res.status(400).json({ error: "Missing endpoint" });
  }

  const ashbyKey = process.env.ASHBY_API_KEY;
  if (!ashbyKey) {
    return res.status(500).json({ error: "Ashby API key not configured" });
  }

  try {
    const response = await fetch(`https://api.ashbyhq.com${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(ashbyKey + ":").toString("base64")}`,
      },
      body: JSON.stringify(body || {}),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
