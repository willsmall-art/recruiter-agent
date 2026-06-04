// pages/api/claude.js
// Proxies requests to Anthropic API server-side — keeps the API key secure

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.status(500).json({ error: "Anthropic API key not configured" });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
                                                                              method: "POST",
                                                                              headers: {
                                                                                "Content-Type": "application/json",
                                                                                "x-api-key": anthropicKey,
                                                                                "anthropic-version": "2023-06-01",
                                                                              },
                                                                              body: JSON.stringify(req.body),
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
