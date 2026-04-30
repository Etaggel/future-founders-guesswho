const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const crypto = require("node:crypto");

const bedrock = new BedrockRuntimeClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const jsonHeaders = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

exports.handler = async (event) => {
  if (event.requestContext?.http?.method === "OPTIONS") {
    return respond(204, {});
  }

  const method = event.requestContext?.http?.method || "GET";
  const path = event.rawPath || "/";
  const userId = event.requestContext?.authorizer?.jwt?.claims?.sub || "anonymous";

  if (path === "/progress" && method === "GET") {
    const result = await ddb.send(
      new GetCommand({
        TableName: process.env.PROGRESS_TABLE_NAME,
        Key: { userId, gameKey: "progress" },
      }),
    );
    return respond(200, result.Item?.payload ?? { mastery: {}, score: 0 });
  }

  if (path === "/progress" && method === "POST") {
    const body = parseBody(event);
    await ddb.send(
      new PutCommand({
        TableName: process.env.PROGRESS_TABLE_NAME,
        Item: {
          userId,
          gameKey: "progress",
          payload: body,
          updatedAt: new Date().toISOString(),
        },
      }),
    );
    return respond(200, { ok: true });
  }

  if (path.startsWith("/ai/facts") && method === "POST") {
    const body = parseBody(event);
    const generated = await generateJson(
      `Create a two-truths-and-one-lie quiz for this founder profile. Return JSON only with {"facts":[{"text":"...","truth":true}],"explanation":"..."}. Exactly two facts must be true and one false. Keep facts useful for in-person conversation. Profile: ${JSON.stringify(body.profile).slice(0, 5000)}`,
      fallbackFacts(body.profile),
    );
    return respond(200, generated);
  }

  if (path.startsWith("/ai/pairs") && method === "POST") {
    const body = parseBody(event);
    const generated = await generateJson(
      `Create one pairs-selection quiz from these attendee profiles. Return JSON only with {"question":"...","answerIds":[1,2],"explanation":"..."}. The question should identify a useful shared trait, company type, category, interest, or conversation angle. Profiles: ${JSON.stringify(body.profiles).slice(0, 7000)}`,
      fallbackPairs(body.profiles),
    );
    return respond(200, generated);
  }

  if (path.startsWith("/ai/relationship") && method === "POST") {
    const body = parseBody(event);
    const generated = await getPairInsight(body);
    return respond(200, generated);
  }

  if (path.startsWith("/ai/idea-explorer") && method === "POST") {
    const body = parseBody(event);
    const generated = await getIdeaExplorerInsight(body);
    return respond(200, generated);
  }

  return respond(404, { error: "Not found" });
};

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  return JSON.parse(raw);
}

async function generateJson(prompt, fallback) {
  try {
    const modelId = process.env.BEDROCK_MODEL_ID || "eu.amazon.nova-lite-v1:0";
    const command = new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        messages: [{ role: "user", content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 700, temperature: 0.7 },
      }),
    });
    const result = await bedrock.send(command);
    const decoded = JSON.parse(Buffer.from(result.body).toString("utf8"));
    const text = decoded.output?.message?.content?.[0]?.text;
    if (!text) return fallback;
    return JSON.parse(text.replace(/^```json\s*/u, "").replace(/```$/u, "").trim());
  } catch (error) {
    return { ...fallback, generated: false, reason: String(error?.message || error) };
  }
}

async function getPairInsight(body) {
  const source = body?.source;
  const target = body?.target;
  const sourceId = Number(source?.id || body?.edge?.source);
  const targetId = Number(target?.id || body?.edge?.target);
  const fallback = fallbackRelationship(body);
  if (!sourceId || !targetId) return fallback;

  const pairKey = pairCacheKey(sourceId, targetId);
  const inputSignature = inputHash({
    schema: "pair-insight-v1",
    pair: canonicalPairInput(sourceId, targetId, body),
  });

  const tableName = process.env.PAIR_INSIGHTS_TABLE_NAME;
  if (tableName) {
    const cached = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pairKey, inputSignature },
      }),
    );
    if (cached.Item?.payload) {
      return { ...cached.Item.payload, cached: true, generatedAt: cached.Item.generatedAt };
    }
  }

  const generated = normalizePairInsight(
    await generateJson(pairInsightPrompt(body), fallback),
    fallback,
  );
  const payload = { ...generated, cached: false };
  const generatedAt = new Date().toISOString();

  if (tableName && generated.generated !== false) {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pairKey,
          inputSignature,
          sourceId,
          targetId,
          payload,
          generatedAt,
        },
      }),
    );
  }

  return { ...payload, generatedAt };
}

async function getIdeaExplorerInsight(body) {
  const idea = typeof body?.idea === "string" ? body.idea.trim() : "";
  const profiles = Array.isArray(body?.profiles) ? body.profiles : [];
  const fallback = fallbackIdeaExplorer(idea, profiles);
  if (!idea || profiles.length === 0) return fallback;

  return normalizeIdeaExplorerInsight(
    await generateJson(ideaExplorerPrompt(idea, profiles), fallback),
    fallback,
    profiles,
  );
}

function canonicalPairInput(sourceId, targetId, body) {
  const profiles = [
    { id: sourceId, attendee: insightProfile(body?.source), matchProfile: body?.sourceProfile || null },
    { id: targetId, attendee: insightProfile(body?.target), matchProfile: body?.targetProfile || null },
  ].sort((a, b) => a.id - b.id);
  return {
    founders: profiles,
    relationship: normalizeRelationshipEdge(body?.edge),
  };
}

function normalizeRelationshipEdge(edge) {
  if (!edge) return null;
  return {
    pair: [Number(edge.source), Number(edge.target)].filter(Boolean).sort((a, b) => a - b),
    score: edge.score,
    relationship_type: edge.relationship_type,
    reasons: edge.reasons || [],
  };
}

function pairInsightPrompt(body) {
  const input = {
    founder_a: insightProfile(body?.source),
    founder_b: insightProfile(body?.target),
    match_metadata: body?.edge || null,
    founder_a_match_profile: body?.sourceProfile || null,
    founder_b_match_profile: body?.targetProfile || null,
  };
  return `You are an AI reasoning layer for co-founder matchmaking at an in-person Future Founders event.
Use only the supplied profile and relationship data. Do not invent personal history, credentials, traction, funding, locations, or private facts.
Be specific, grounded, practical, and concise. If evidence is thin, say what to validate rather than pretending certainty.
Return JSON only with exactly this shape:
{"headline":"short compelling summary","common_ground":["shared theme 1","shared theme 2","shared theme 3"],"cofounder_fit":"reasoning about complementarity and risks","conversation_starters":["question 1","question 2","question 3"],"business_opportunities":["realistic startup idea 1","realistic startup idea 2"]}
Input data: ${JSON.stringify(input).slice(0, 10000)}`;
}

function ideaExplorerPrompt(idea, profiles) {
  const input = {
    idea_or_problem: idea.slice(0, 2500),
    founders: profiles.map(insightProfile).filter(Boolean),
  };
  return `You are an AI reasoning layer for a private founder networking prep tool at an in-person Future Founders event.
The user entered a business idea, problem, or market they want to explore. Compare it against every supplied founder profile.
Use only the supplied profile data. Do not invent private facts, traction, funding, current projects, willingness to help, or relationships.
Do not echo the user's idea back verbatim. Keep recommendations practical for an event conversation.
Return JSON only with exactly this shape:
{"headline":"short useful title","summary":"one concise paragraph","recommendations":[{"attendeeId":1,"relevance":"High","why":["grounded reason 1","grounded reason 2"],"questions":["question 1","question 2"],"evidence":["profile evidence 1","profile evidence 2"]}],"privacyNote":"This app does not store this idea or these generated matches."}
Return 3 to 6 recommendations. Each attendeeId must be from the supplied founders list. Input data: ${JSON.stringify(input).slice(0, 18000)}`;
}

function insightProfile(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.identified_person?.name || profile.likely_match?.name || null,
    tagline: profile.tagline,
    category: profile.category,
    role: profile.identified_person?.role || profile.likely_match?.role || null,
    company: profile.identified_person?.company || profile.likely_match?.company || null,
    background: profile.profile_summary?.background || null,
    interests: profile.profile_summary?.interests || [],
    facts: (profile.extra_facts || []).map((item) => item.fact),
    conversation_starters: profile.conversation_starters || [],
  };
}

function pairCacheKey(sourceId, targetId) {
  return [sourceId, targetId].sort((a, b) => a - b).join("#");
}

function inputHash(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizePairInsight(value, fallback) {
  return {
    headline: stringValue(value?.headline, fallback.headline),
    common_ground: stringArray(value?.common_ground, fallback.common_ground, 3),
    cofounder_fit: stringValue(value?.cofounder_fit, fallback.cofounder_fit),
    conversation_starters: stringArray(value?.conversation_starters, fallback.conversation_starters, 3),
    business_opportunities: stringArray(value?.business_opportunities, fallback.business_opportunities, 2),
    generated: value?.generated !== false,
    reason: value?.reason,
  };
}

function normalizeIdeaExplorerInsight(value, fallback, profiles) {
  const validIds = new Set((profiles || []).map((profile) => Number(profile?.id)).filter(Boolean));
  const rawRecommendations = Array.isArray(value?.recommendations) ? value.recommendations : [];
  const recommendations = rawRecommendations
    .map((item) => normalizeIdeaRecommendation(item, profiles))
    .filter((item) => item && validIds.has(item.attendeeId))
    .slice(0, 6);
  return {
    headline: stringValue(value?.headline, fallback.headline),
    summary: stringValue(value?.summary, fallback.summary),
    recommendations: recommendations.length ? recommendations : fallback.recommendations,
    privacyNote: "This app does not log your idea, store it, or save these generated matches.",
    generated: value?.generated !== false,
  };
}

function normalizeIdeaRecommendation(item, profiles) {
  const attendeeId = Number(item?.attendeeId ?? item?.id);
  if (!attendeeId) return null;
  const profile = (profiles || []).find((candidate) => Number(candidate?.id) === attendeeId);
  return {
    attendeeId,
    name: stringValue(item?.name, profile ? profileName(profile) : `Attendee #${attendeeId}`),
    relevance: stringValue(item?.relevance, "Relevant"),
    why: stringArray(item?.why, [profile?.tagline || "Profile data suggests a useful conversation angle."], 3),
    questions: stringArray(item?.questions, profile?.conversation_starters || ["What part of this problem feels most urgent from your perspective?"], 3),
    evidence: stringArray(item?.evidence, profileFactsForIdea(profile), 3),
  };
}

function stringValue(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringArray(value, fallback, limit) {
  const items = Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : [];
  return (items.length ? items : fallback).slice(0, limit);
}

function fallbackFacts(profile) {
  const facts = (profile?.extra_facts || []).slice(0, 2).map((x) => ({ text: x.fact, truth: true }));
  return {
    facts: [...facts, { text: "Has never worked with teams outside Ireland.", truth: false }].slice(0, 3),
    explanation: "Fallback quiz generated from local profile facts.",
  };
}

function fallbackPairs(profiles) {
  const technical = (profiles || []).filter((p) => p.category === "Technical").map((p) => p.id);
  return {
    question: "Select everyone whose profile is currently tagged Technical.",
    answerIds: technical,
    explanation: "Fallback pairs prompt based on the dataset category field.",
  };
}

function fallbackRelationship(body) {
  const sourceName = body?.source?.identified_person?.name || body?.source?.likely_match?.name || `Attendee #${body?.edge?.source || "A"}`;
  const targetName = body?.target?.identified_person?.name || body?.target?.likely_match?.name || `Attendee #${body?.edge?.target || "B"}`;
  const reasons = body?.edge?.reasons || [];
  const sourceInterests = body?.source?.profile_summary?.interests || [];
  const targetInterests = body?.target?.profile_summary?.interests || [];
  const sharedInterests = sourceInterests.filter((interest) => targetInterests.includes(interest));
  return {
    headline: `${sourceName} × ${targetName}: ${body?.edge?.relationship_type || "relationship"}`,
    common_ground: (sharedInterests.length ? sharedInterests : reasons).slice(0, 3),
    cofounder_fit: reasons.length
      ? `The known match signals point to ${reasons.slice(0, 2).join(" and ")}. Validate current priorities before framing this as a co-founder fit.`
      : "The available profile data is limited, so treat this as a prompt to test overlap, complementary skills, and working style before assuming fit.",
    conversation_starters: [
      `What would make a conversation between ${sourceName} and ${targetName} useful in the next month?`,
      "Where do your assumptions about this market or customer differ?",
      "Which skill gap would be most valuable to close with a collaborator?",
    ],
    business_opportunities: [
      "A focused validation sprint around the strongest shared customer or domain signal in their profiles.",
      "A lightweight tool or service that combines one founder's domain access with the other's execution strengths.",
    ],
    generated: false,
  };
}

function fallbackIdeaExplorer(idea, profiles) {
  const terms = Array.from(new Set((idea.toLowerCase().match(/[a-z0-9]{4,}/gu) || []).filter((term) => !COMMON_IDEA_TERMS.has(term))));
  const scored = (profiles || [])
    .map((profile) => ({ profile, score: ideaProfileScore(profile, terms) }))
    .sort((a, b) => b.score - a.score || Number(a.profile?.id || 0) - Number(b.profile?.id || 0))
    .slice(0, 5)
    .map(({ profile, score }) => ({
      attendeeId: Number(profile?.id),
      name: profileName(profile),
      relevance: score >= 3 ? "High" : score >= 1 ? "Medium" : "Exploratory",
      why: [
        profile?.tagline || "This founder has a useful profile angle for a first conversation.",
        profile?.profile_summary?.background || "Use the conversation to validate whether their current priorities overlap with the idea.",
      ].filter(Boolean).slice(0, 2),
      questions: (profile?.conversation_starters || [
        "What customer pain would you validate first here?",
        "Which assumption would make or break this opportunity?",
      ]).slice(0, 3),
      evidence: profileFactsForIdea(profile),
    }))
    .filter((item) => item.attendeeId);

  return {
    headline: idea ? "Founder matches for your idea" : "Describe an idea to find founder matches",
    summary: idea
      ? "Fallback recommendations are based on profile keywords, categories, interests, and conversation starters while the AI insight service is unavailable."
      : "Enter a business idea, customer problem, or market thesis to find useful founder conversations.",
    recommendations: scored,
    privacyNote: "This app does not log your idea, store it, or save these generated matches.",
    generated: false,
  };
}

function ideaProfileScore(profile, terms) {
  const haystack = [
    profile?.tagline,
    profile?.category,
    profile?.identified_person?.role,
    profile?.identified_person?.company,
    profile?.likely_match?.role,
    profile?.likely_match?.company,
    profile?.profile_summary?.background,
    ...(profile?.profile_summary?.interests || []),
    ...(profile?.extra_facts || []).map((item) => item.fact),
    ...(profile?.conversation_starters || []),
  ].filter(Boolean).join(" ").toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function profileName(profile) {
  return profile?.identified_person?.name || profile?.likely_match?.name || `Attendee #${profile?.id || "?"}`;
}

function profileFactsForIdea(profile) {
  return [
    profile?.tagline,
    ...(profile?.profile_summary?.interests || []).map((interest) => `Interested in ${interest}`),
    ...(profile?.extra_facts || []).map((item) => item.fact),
  ].filter(Boolean).slice(0, 3);
}

const COMMON_IDEA_TERMS = new Set([
  "about",
  "business",
  "company",
  "could",
  "founder",
  "idea",
  "market",
  "problem",
  "product",
  "startup",
  "there",
  "their",
  "these",
  "would",
]);

function respond(statusCode, body) {
  return { statusCode, headers: jsonHeaders, body: statusCode === 204 ? "" : JSON.stringify(body) };
}
