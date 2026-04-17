exports.handler = async function (event) {

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const API_KEY = process.env.GROQ_API_KEY;
  if (!API_KEY) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'GROQ_API_KEY not set in Netlify environment variables.' })
    };
  }

  let content;
  try {
    const body = JSON.parse(event.body);
    content = body.content;
    if (!content) throw new Error('no content');
  } catch (e) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing content field.' })
    };
  }

  // ── SYSTEM PROMPT: Professional fact-checker persona ──
  const systemPrompt = `You are an expert misinformation analyst with 20 years of experience in investigative journalism, fact-checking, and media literacy. You have worked for Reuters, AP Fact Check, Snopes, and PolitiFact. You apply rigorous, evidence-based methodology to assess news credibility.

Your analysis process:
1. LINGUISTIC ANALYSIS — Detect sensationalist language, emotional manipulation, ALL CAPS, excessive exclamation marks, vague attribution ("sources say", "experts claim" without naming them), weasel words
2. STRUCTURAL ANALYSIS — Check if it has who/what/when/where/why, named sources, specific data, dates, verifiable claims
3. CLAIM VERIFICATION SIGNALS — Look for internally contradictory statements, implausible claims, scientific impossibilities, logical fallacies
4. SOURCE CREDIBILITY — Named journalists, known outlets, official statements vs anonymous sources, unknown blogs
5. NARRATIVE PATTERNS — Conspiracy theory markers (cover-up framing, "they don't want you to know", suppression claims), us-vs-them framing, scapegoating
6. POLITICAL BIAS — One-sided framing, selective facts, loaded language favoring one political group
7. EMOTIONAL MANIPULATION — Fear, outrage, urgency tactics designed to bypass critical thinking
8. CONTEXT INTEGRITY — Is the headline consistent with the content? Are statistics presented accurately or cherry-picked?

SCORING RULES (be precise and consistent, not random):
- credibility 0-15: Clear misinformation, conspiracy theory, fabricated quotes, impossible claims
- credibility 16-35: Heavy red flags — no sources, extreme claims, emotional manipulation
- credibility 36-55: Mixed signals — some facts but lacking sources or exaggerated
- credibility 56-75: Mostly credible but missing context or has minor inaccuracies
- credibility 76-90: Credible — named sources, specific facts, standard journalistic format
- credibility 91-100: Highly credible — multiple named sources, data, professional outlet

- risk (spread of harm): How dangerous is this if shared and believed?
- confidence: How certain are you of this verdict? (lower if content is ambiguous)

VERDICT RULES (strict):
- FAKE: credibility < 40 AND clear fabrication/manipulation signals present
- REAL: credibility > 65 AND no major red flags
- UNCERTAIN: everything in between, or if content is too short to judge

You MUST respond with ONLY a raw JSON object. No markdown. No explanation. No preamble.`;

  // ── USER PROMPT: Structured analysis request ──
  const userPrompt = `Analyze this content for misinformation. Think step by step internally, then output ONLY the JSON result.

CONTENT TO ANALYZE:
"""
${content.slice(0, 3000)}
"""

Apply all 8 analysis criteria. Be SPECIFIC in your factors — reference actual words or phrases from the content. Do NOT give generic answers.

Return this exact JSON structure:
{
  "verdict": "FAKE" | "REAL" | "UNCERTAIN",
  "credibility": <0-100 integer>,
  "risk": <0-100 integer>,
  "confidence": <0-100 integer>,
  "bias_position": <0=far-left, 25=left, 50=center, 75=right, 100=far-right>,
  "bias_label": "<Far Left | Left-Leaning | Center-Left | Neutral | Center-Right | Right-Leaning | Far Right>",
  "bias_explanation": "<one specific sentence citing actual language in the content that shows this bias>",
  "factors": [
    {"type": "negative", "text": "<specific red flag quoting or referencing actual content>"},
    {"type": "negative", "text": "<another specific red flag>"},
    {"type": "negative", "text": "<another if applicable>"},
    {"type": "positive", "text": "<credible element if any, or omit if none>"},
    {"type": "neutral", "text": "<contextual observation>"}
  ],
  "linguistic_score": <0-100, how sensationalist is the language>,
  "source_score": <0-100, how well-sourced is it>,
  "claim_score": <0-100, how verifiable/plausible are the claims>,
  "summary": "<3-4 sentence specific analysis referencing ACTUAL content — what exact claims are suspicious or credible and why>",
  "tips": [
    "<specific verification action for THIS content>",
    "<specific fact-check site or source to check>",
    "<specific search query to verify the main claim>"
  ]
}

CRITICAL: 
- factors must reference SPECIFIC words/phrases from the actual content
- summary must mention the ACTUAL topic being analyzed  
- tips must be SPECIFIC to this content, not generic advice
- Do NOT output markdown, only raw JSON`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_KEY
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1800,
        temperature: 0.05,   // very low — consistent, analytical, not creative
        top_p: 0.9,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   }
        ]
      })
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      return {
        statusCode: groqRes.status,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Groq API error ' + groqRes.status + ': ' + errText.slice(0, 300) })
      };
    }

    const groqData = await groqRes.json();

    let aiText = '';
    try {
      aiText = groqData.choices[0].message.content.trim();
    } catch (e) {
      return {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Groq returned unexpected structure: ' + JSON.stringify(groqData).slice(0, 300) })
      };
    }

    // Parse JSON — multiple fallback strategies
    let result = null;
    try { result = JSON.parse(aiText); } catch(e) {}
    if (!result) {
      const stripped = aiText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
      try { result = JSON.parse(stripped); } catch(e) {}
    }
    if (!result) {
      const first = aiText.indexOf('{');
      const last  = aiText.lastIndexOf('}');
      if (first !== -1 && last > first) {
        try { result = JSON.parse(aiText.slice(first, last + 1)); } catch(e) {}
      }
    }
    if (!result) {
      const match = aiText.match(/\{[\s\S]+\}/);
      if (match) { try { result = JSON.parse(match[0]); } catch(e) {} }
    }

    if (!result || !result.verdict) {
      return {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Could not parse AI response. Raw: ' + aiText.slice(0, 400) })
      };
    }

    // ── NORMALISE & VALIDATE ──
    const verdicts = ['FAKE', 'REAL', 'UNCERTAIN'];
    result.verdict = String(result.verdict).toUpperCase().trim();
    if (!verdicts.includes(result.verdict)) result.verdict = 'UNCERTAIN';

    const clamp = (v, def) => Math.min(100, Math.max(0, parseInt(v) || def));
    result.credibility    = clamp(result.credibility, 50);
    result.risk           = clamp(result.risk, 50);
    result.confidence     = clamp(result.confidence, 50);
    result.bias_position  = clamp(result.bias_position, 50);
    result.linguistic_score = clamp(result.linguistic_score, 50);
    result.source_score   = clamp(result.source_score, 50);
    result.claim_score    = clamp(result.claim_score, 50);

    // ── ENFORCE VERDICT CONSISTENCY ──
    // If scores strongly suggest a different verdict, correct it
    if (result.credibility < 35 && result.verdict === 'REAL')      result.verdict = 'UNCERTAIN';
    if (result.credibility < 20 && result.verdict !== 'FAKE')       result.verdict = 'FAKE';
    if (result.credibility > 70 && result.verdict === 'FAKE')       result.verdict = 'UNCERTAIN';
    if (result.credibility > 80 && result.verdict !== 'REAL')       result.verdict = 'REAL';

    if (!Array.isArray(result.factors)) result.factors = [];
    if (!Array.isArray(result.tips))    result.tips    = ['Search the main claim on Google with "fact check" added.'];
    if (!result.summary)        result.summary        = 'Analysis complete.';
    if (!result.bias_label)     result.bias_label     = 'Neutral';
    if (!result.bias_explanation) result.bias_explanation = '';

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true, result })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Server error: ' + err.message })
    };
  }
};
