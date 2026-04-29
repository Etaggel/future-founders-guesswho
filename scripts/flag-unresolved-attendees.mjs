import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const filePath = path.join(root, "attendees.json");
const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

const unresolved = (data.founders ?? []).filter((f) => {
  const confidence = f.identified_person?.confidence ?? f.likely_match?.confidence ?? 0;
  const hasLinkedIn = Boolean(
    f.identified_person?.linkedin_url ?? f.likely_match?.linkedin_url,
  );
  return confidence < 0.75 || !hasLinkedIn;
});

console.log("Unresolved attendee profiles:");
for (const item of unresolved) {
  const confidence = item.identified_person?.confidence ?? item.likely_match?.confidence ?? 0;
  const name = item.identified_person?.name ?? item.likely_match?.name ?? `Attendee #${item.id}`;
  console.log(`- ID ${item.id}: ${name} (confidence=${confidence})`);
}
