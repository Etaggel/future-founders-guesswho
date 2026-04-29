const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

const bedrock = new BedrockRuntimeClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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
    const generated = await generateJson(
      `Study this founder relationship for an in-person Future Founders event. Return JSON only with {"headline":"...","openingMove":"...","whyItWorks":["..."],"watchOuts":["..."],"usefulQuestions":["..."]}. Keep it practical, specific, and non-creepy. Relationship: ${JSON.stringify(body).slice(0, 8000)}`,
      fallbackRelationship(body),
    );
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
    const modelId = process.env.BEDROCK_MODEL_ID || "amazon.nova-lite-v1:0";
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
  return {
    headline: `${sourceName} × ${targetName}: ${body?.edge?.relationship_type || "relationship"}`,
    openingMove: `Ask ${targetName} which part of ${sourceName}'s work feels most relevant to what they are building now.`,
    whyItWorks: reasons.slice(0, 3),
    watchOuts: [
      "Use the score as a prompt for curiosity, not as a claim of guaranteed fit.",
      "Confirm current priorities before suggesting a collaboration.",
    ],
    usefulQuestions: [
      "What would make this connection useful in the next month?",
      "Where do your assumptions about this market differ?",
      "Who else in the room should join this thread?",
    ],
    generated: false,
  };
}

function respond(statusCode, body) {
  return { statusCode, headers: jsonHeaders, body: statusCode === 204 ? "" : JSON.stringify(body) };
}
