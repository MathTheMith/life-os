import { Router } from "express";
import { db } from "../db.js";
import { toolDefinitions, executeTool, getGlobalMemory, getAssistantNotes } from "../chatTools.js";
import { saveImageDataUrl } from "../imageStore.js";
import { describeImage } from "../imageDescribe.js";
import { callAiService } from "../aiClient.js";
import { getProfileForPrompt } from "./profile.js";
import { getJournalForPrompt, getEveningInstructions } from "./journal.js";

export const chatRouter = Router();

const MAX_TOOL_ROUNDS = 5;
// Generous but still bounded — a conversation shouldn't grow the request
// unboundedly forever, but Gemini's free-tier token budget (250k+ TPM) is
// no longer the tight constraint it was on Groq, so this can stay high.
const MAX_HISTORY_MESSAGES = 30;

interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

const IMAGE_MARKER = "\n\n[Description détaillée de l'image jointe]\n";

// Folds an image's description into the message text sent to the model —
// images themselves never travel past imageDescribe.ts (see there for why).
function withImageDescription(content: string, description?: string | null): string {
  return description ? `${content}${IMAGE_MARKER}${description}` : content;
}

// The one dedicated endpoint that ever sends raw image bytes anywhere. The
// frontend calls this as soon as a photo is attached (before Send is even
// enabled) so the description is ready to fold into the outgoing message —
// no image ever needs to be resent turn after turn.
chatRouter.post("/describe-image", async (req, res) => {
  const { image } = req.body as { image?: string };
  if (!image) return res.status(400).json({ error: "image requise" });
  try {
    res.json({ description: await describeImage(image) });
  } catch (err) {
    console.error("Erreur description image:", err);
    res.status(502).json({ error: (err as Error).message || "Description d'image indisponible." });
  }
});

chatRouter.post("/", async (req, res) => {
  const {
    conversationId,
    message,
    messages: clientMessages,
    image: incomingImage,
    imageDescription: incomingImageDescription,
  } = req.body as {
    conversationId?: number;
    message?: string;
    messages?: (ChatMessage & { imageDescription?: string })[];
    image?: string; // data: URI — kept around only to persist to disk for display, never sent to the model here
    imageDescription?: string; // already computed by /describe-image before this request was sent
  };

  let conversation: { id: number; title: string; memory: string | null; kind: string } | undefined;
  let history: ChatMessage[];
  let userMessage: string | undefined;

  if (conversationId) {
    conversation = db.prepare("SELECT id, title, memory, kind FROM conversations WHERE id = ?").get(conversationId) as
      | { id: number; title: string; memory: string | null; kind: string }
      | undefined;
    if (!conversation) return res.status(404).json({ error: "Conversation introuvable." });
    if (!message && !incomingImage) return res.status(400).json({ error: "message ou image requis" });

    userMessage = message || "";
    const rows = db
      .prepare(
        "SELECT role, content, image_description FROM conversation_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?"
      )
      .all(conversationId, MAX_HISTORY_MESSAGES) as { role: string; content: string; image_description: string | null }[];
    rows.reverse();
    history = rows.map((r) => ({
      role: r.role as ChatMessage["role"],
      content: withImageDescription(r.content, r.image_description),
    }));
    history.push({ role: "user", content: withImageDescription(userMessage, incomingImageDescription) });
  } else {
    if (!clientMessages || clientMessages.length === 0) {
      return res.status(400).json({ error: "messages requis (tableau non vide)" });
    }
    history = clientMessages
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, content: withImageDescription(m.content, m.imageDescription) }));
  }

  const globalMemory = getGlobalMemory();
  let systemPrompt =
    "Tu es l'assistant personnel de Mathéo dans Life OS, son application de vie (finances, objectifs, motorsport, carrière). " +
    "Ton rôle : l'aider concrètement à avancer vers les rêves et objectifs décrits dans son profil ci-dessous, qui priment sur tout le reste. Sois précis, méthodique, concis et direct. " +
    "S'il te manque une information importante pour bien le conseiller (situation, contrainte, préférence), pose-lui la question plutôt que de supposer. " +
    "Utilise les outils de lecture pour toute question précise sur ses finances, objectifs ou courses plutôt que de deviner à partir de ce que tu crois savoir. " +
    "Si une question nécessite plusieurs outils, demande-les tous en un seul tour (plusieurs appels dans la même réponse) plutôt qu'un par un dans des tours séparés — le budget de requêtes disponible est limité. " +
    "N'appelle update_profile_section, update_global_memory ou update_chat_memory QUE si Mathéo a explicitement dit oui ou demandé de retenir/changer quelque chose. " +
    "Si tu remarques toi-même un changement qui mériterait d'être retenu (nouveau rêve ou objectif, préférence, changement de situation...), propose-le-lui dans ta réponse et attends sa confirmation avant d'appeler l'outil. " +
    "En revanche, tu as ta propre mémoire personnelle (« Tes notes ») : c'est à toi, tu y écris quand tu veux via update_assistant_notes, sans demander la permission — ce que tu apprends sur Mathéo, sa façon de communiquer, ce qui marche avec lui, tes observations. Garde-la courte, fusionne et supprime l'obsolète plutôt que d'empiler.";

  const profile = getProfileForPrompt();
  if (profile) systemPrompt += `\n\n## Profil de Mathéo (écrit par lui, la référence pour tout conseil)\n${profile}`;
  if (globalMemory) systemPrompt += `\n\n## Mémoire globale (partagée entre toutes les conversations)\n${globalMemory}`;
  const assistantNotes = getAssistantNotes();
  if (assistantNotes) systemPrompt += `\n\n## Tes notes personnelles (ta propre mémoire, tu la gères seul)\n${assistantNotes}`;
  if (conversation?.memory) systemPrompt += `\n\n## Mémoire propre à cette conversation\n${conversation.memory}`;
  const journal = getJournalForPrompt(14);
  if (journal) systemPrompt += `\n\n## Journal des 14 derniers jours (résumés de ses chats du soir)\n${journal}`;
  if (conversation?.kind === "soir") systemPrompt += `\n\n${getEveningInstructions()}`;

  const tools = toolDefinitions(!!conversationId);
  const workingMessages: any[] = [{ role: "system", content: systemPrompt }, ...history];

  try {
    let finalText = "";
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const data = await callAiService({ messages: workingMessages, tools });
      const assistantMessage = data.choices?.[0]?.message;
      if (!assistantMessage) throw new Error("Réponse inattendue du modèle.");

      if (assistantMessage.tool_calls?.length) {
        workingMessages.push(assistantMessage);
        for (const call of assistantMessage.tool_calls) {
          const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
          const result = executeTool(call.function.name, args, conversationId ?? null);
          workingMessages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
        continue;
      }

      finalText = assistantMessage.content || "";
      break;
    }

    if (!finalText) finalText = "Désolé, je n'ai pas réussi à formuler de réponse.";

    if (conversationId && conversation) {
      const conv = conversation;
      const finalUserMessage = userMessage || "";

      // Written to disk outside the transaction (better-sqlite3 transactions
      // must be synchronous, this isn't) — a failure here still lets the
      // reply through, just without the image attached to the saved row.
      let imagePath: string | null = null;
      if (incomingImage) {
        try {
          imagePath = saveImageDataUrl(incomingImage);
        } catch (err) {
          console.error("Échec sauvegarde image:", (err as Error).message);
        }
      }

      const insert = db.prepare(
        "INSERT INTO conversation_messages (conversation_id, role, content, image_path, image_description) VALUES (?, ?, ?, ?, ?)"
      );
      const saveExchange = db.transaction(() => {
        insert.run(conversationId, "user", finalUserMessage, imagePath, incomingImageDescription ?? null);
        insert.run(conversationId, "assistant", finalText, null, null);
        db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conversationId);
        if (conv.title === "Nouvelle conversation") {
          const titleSource = finalUserMessage || "Image";
          const title = titleSource.slice(0, 48) + (titleSource.length > 48 ? "…" : "");
          db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, conversationId);
        }
      });
      saveExchange();
    }

    res.json({ reply: finalText });
  } catch (err) {
    console.error("Erreur chat:", err);
    res.status(502).json({ error: (err as Error).message || "Service de chat indisponible." });
  }
});
