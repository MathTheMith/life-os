const aiServiceUrl = process.env.AI_SERVICE_URL || "http://localhost:4000";
const internalSecret = process.env.INTERNAL_SECRET;

const DESCRIBE_PROMPT =
  "Décris cette image de façon très détaillée et structurée, en français. Note absolument tout ce qui est " +
  "visible et utile : objets, texte lisible (montants, dates, noms, numéros, marques...), contexte probable, " +
  "état général. Ce résumé va complètement remplacer l'image dans la conversation avec l'utilisateur — lui et " +
  "toi ne reverrez plus jamais l'image elle-même, seulement ce texte — donc n'omets aucun détail qui pourrait " +
  "servir plus tard, même si ça fait un résumé long.";

/**
 * The only place a raw image ever reaches Gemini. Every image sent in the
 * app is described once here, right when it's attached — the description
 * (always smaller than the photo, however "gros et détaillé" it is) is what
 * actually travels through the conversation from then on, in every future
 * turn, instead of the image bytes. Throws on failure; callers decide how
 * to surface that (the dedicated route turns it into a 502).
 */
export async function describeImage(imageDataUrl: string): Promise<string> {
  const response = await fetch(`${aiServiceUrl}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(internalSecret ? { "x-internal-secret": internalSecret } : {}),
    },
    body: JSON.stringify({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: DESCRIBE_PROMPT },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
      reasoning_effort: "low",
      // Deliberately generous — a thorough description is the whole point,
      // and it only ever runs once per image, not once per turn.
      max_completion_tokens: 3000,
    }),
  });
  const data = (await response.json()) as any;
  if (!response.ok) {
    const errorObj = Array.isArray(data) ? data[0]?.error : data?.error;
    throw new Error((typeof errorObj === "string" ? errorObj : errorObj?.message) || `ai-service a répondu ${response.status}`);
  }
  const description: string = data.choices?.[0]?.message?.content ?? "";
  if (!description.trim()) throw new Error("Description vide reçue du modèle.");
  return description;
}
