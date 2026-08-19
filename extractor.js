// The actual AI integration. Talks to Groq's OpenAI-compatible endpoint and
// forces the model to return clean JSON matching a fixed schema per type.
//
// The interesting engineering problem here isn't "call an API" — it's making
// an LLM reliably output *valid, structured* data instead of chatty prose.
// That's handled with: a strict system prompt, JSON mode, a defined schema
// per extraction type, and defensive parsing on the way back.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "openai/gpt-oss-120b";

// Each supported type has a fixed shape the model must return. Giving the
// model an explicit schema is what turns "summarize this" (unreliable) into
// "fill these exact fields" (reliable).
const SCHEMAS = {
  job_posting: {
    description: "a job posting",
    fields: {
      title: "string — the job title",
      company: "string or null — the hiring company if named",
      location: "string or null — location, or 'Remote' if remote",
      remote: "boolean — true if the role is remote or remote-friendly",
      seniority: "string or null — one of: intern, junior, mid, senior, lead, or null if unclear",
      required_skills: "array of strings — key technical skills or tools required",
      employment_type: "string or null — e.g. full-time, part-time, contract",
    },
  },
  product: {
    description: "a product description",
    fields: {
      name: "string — the product name",
      category: "string or null — product category",
      price: "string or null — price with currency if mentioned",
      key_features: "array of strings — main features or selling points",
      target_audience: "string or null — who the product is for",
    },
  },
  contact: {
    description: "a block of contact information or an email signature",
    fields: {
      name: "string or null — person's full name",
      email: "string or null",
      phone: "string or null",
      company: "string or null",
      role: "string or null — job title",
      website: "string or null",
    },
  },
};

function buildSystemPrompt(type) {
  const schema = SCHEMAS[type];
  const fieldLines = Object.entries(schema.fields)
    .map(([key, desc]) => `  "${key}": ${desc}`)
    .join(",\n");

  return `You are a precise data extraction engine. You are given ${schema.description} as raw text and must extract it into JSON.

Return ONLY a JSON object with exactly these fields:
{
${fieldLines}
}

Rules:
- Extract only what is actually present in the text. Do not invent values.
- Use null for any field you cannot determine from the text.
- For array fields, return an empty array if nothing applies.
- Return ONLY the JSON object, no explanation, no markdown, no code fences.`;
}

export async function extractStructuredData(text, type) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    const e = new Error("GROQ_API_KEY is not set");
    e.code = "UPSTREAM_ERROR";
    throw e;
  }

  let response;
  try {
    response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0, // deterministic — we want extraction, not creativity
        response_format: { type: "json_object" }, // JSON mode: model must emit valid JSON
        messages: [
          { role: "system", content: buildSystemPrompt(type) },
          { role: "user", content: text },
        ],
      }),
    });
  } catch (networkErr) {
    const e = new Error("Failed to reach the AI provider");
    e.code = "UPSTREAM_ERROR";
    throw e;
  }

  if (!response.ok) {
    const e = new Error(`Groq API returned ${response.status}`);
    e.code = "UPSTREAM_ERROR";
    throw e;
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;

  if (!content) {
    const e = new Error("Empty response from model");
    e.code = "PARSE_ERROR";
    throw e;
  }

  // Even with JSON mode, parse defensively — never trust that the upstream
  // gave us what it promised.
  try {
    return JSON.parse(content);
  } catch (parseErr) {
    const e = new Error("Model output was not valid JSON");
    e.code = "PARSE_ERROR";
    throw e;
  }
}
