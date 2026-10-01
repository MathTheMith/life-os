import { Router } from "express";
import { db } from "../db.js";
import { toolDefinitions, executeTool, getGlobalMemory, getAssistantNotes } from "../chatTools.js";
import { saveImageDataUrl } from "../imageStore.js";
import { describeImage } from "../imageDescribe.js";
import { callAiService } from "../aiClient.js";
import { getProfileForPrompt } from "./profile.js";
import { getJournalForPrompt, getEveningInstructions } from "./journal.js";
import { getWatchForPrompt } from "../watch.js";
import { getAgendaForPrompt } from "./agenda.js";
import { getMailForPrompt, getSentMailForPrompt } from "../mail.js";
import { getTodayBriefForPrompt } from "../brief.js";
import { getActionsForPrompt } from "../actions.js";
import { toneInstructions } from "../coach.js";
import { isClaudeTrigger, askClaudeBridge } from "../claudeBridge.js";

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

// A second, independent Gemini call that relits the draft reply before it
// reaches Mathéo — catches an obviously invented number/date/name or an
// internal contradiction. Same model as the one that wrote it, so this is
// a partial safety net, not a real second opinion: it can share the same
// blind spots. Told to be conservative (don't touch what isn't actually
// wrong) so it doesn't turn into noisy cosmetic rewrites. Only called when
// the turn used a web tool (see below) — that's where an invented or
// misread detail is both most likely and hardest to catch unaided, and it
// keeps this from doubling the cost/latency of every single message.
// Fails open — any error here just keeps the original draft.
async function critiqueReply(userMessage: string, draftReply: string): Promise<string> {
  const prompt =
    "Tu relis une réponse qu'une IA s'apprête à envoyer à Mathéo, avant qu'il la voie — un dernier filet de sécurité. " +
    "Vérifie uniquement : une affirmation inventée, un chiffre/date/nom qui semble sorti de nulle part, ou une contradiction interne. " +
    "Ne touche à RIEN d'autre — pas de reformulation cosmétique, pas de changement de ton, même si tu l'aurais écrite différemment. " +
    "Si tout va bien (y compris si elle dit honnêtement ne pas savoir), réponds exactement OK, rien d'autre. " +
    "Si tu trouves un vrai problème, réponds uniquement par la version corrigée, dans la même langue et le même ton, sans aucun commentaire autour.\n\n" +
    `Message de Mathéo :\n${userMessage}\n\nRéponse à relire :\n${draftReply}`;
  try {
    const data = await callAiService({ messages: [{ role: "user", content: prompt }], reasoning_effort: "low" });
    const result = (data.choices?.[0]?.message?.content ?? "").trim();
    if (!result || result.toUpperCase() === "OK") return draftReply;
    return result;
  } catch (err) {
    console.error("Relecture critique échouée, réponse originale conservée:", (err as Error).message);
    return draftReply;
  }
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
    "Exception : quand il répond à une question que TU lui as posée sur lui (sa vie, ses ambitions, son matériel, sa situation...), enregistre directement sa réponse dans la bonne section du profil avec update_profile_section, sans demander, en gardant le reste de la section, puis dis-lui en une ligne ce que tu as retenu. " +
    "En revanche, tu as ta propre mémoire personnelle (« Tes notes ») : c'est à toi, tu y écris quand tu veux via update_assistant_notes, sans demander la permission — ce que tu apprends sur Mathéo, sa façon de communiquer, ce qui marche avec lui, tes observations. Garde-la courte, fusionne et supprime l'obsolète plutôt que d'empiler.";

  const now = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
  systemPrompt +=
    `\n\nNous sommes le ${now} (heure de Paris). ` +
    "Tu tiens son agenda : dès qu'il mentionne un rendez-vous, une échéance, une course ou te demande un rappel, ajoute-le directement avec add_agenda_event (sans demander), puis dis-lui ce que tu as ajouté. " +
    "Pour un rappel « dans X jours », calcule la date à partir d'aujourd'hui. " +
    "Chaque événement a des rappels (notifications sur son téléphone) : choisis-les selon l'importance, et s'il demande des rappels précis, respecte-les.";

  systemPrompt += `\n\n${toneInstructions()}`;

  const profile = getProfileForPrompt();
  if (profile) systemPrompt += `\n\n## Profil de Mathéo (écrit par lui, la référence pour tout conseil)\n${profile}`;
  if (globalMemory) systemPrompt += `\n\n## Mémoire globale (partagée entre toutes les conversations)\n${globalMemory}`;
  const assistantNotes = getAssistantNotes();
  if (assistantNotes) systemPrompt += `\n\n## Tes notes personnelles (ta propre mémoire, tu la gères seul)\n${assistantNotes}`;
  if (conversation?.memory) systemPrompt += `\n\n## Mémoire propre à cette conversation\n${conversation.memory}`;
  const journal = getJournalForPrompt(14);
  if (journal) systemPrompt += `\n\n## Journal des 14 derniers jours (résumés de ses chats du soir)\n${journal}`;
  const agenda = getAgendaForPrompt();
  if (agenda) systemPrompt += `\n\n## Agenda des 3 prochaines semaines\n${agenda}`;
  const mails = getMailForPrompt();
  if (mails) systemPrompt += `\n\n## Mails importants des 3 derniers jours\n${mails}`;
  const sentMails = getSentMailForPrompt();
  if (sentMails) systemPrompt += `\n\n## Mails que Mathéo a lui-même envoyés dans les 30 derniers jours\n${sentMails}`;
  const brief = getTodayBriefForPrompt();
  if (brief) systemPrompt += `\n\n## Le brief que tu lui as envoyé ce matin\n${brief}`;
  const actions = getActionsForPrompt();
  if (actions) systemPrompt += `\n\n## Actions que tu lui as préparées (il les valide dans l'onglet Aujourd'hui)\n${actions}`;
  const watch = getWatchForPrompt();
  if (watch) systemPrompt += `\n\n## Veille : trouvailles pertinentes des 7 derniers jours (score sur 100)\n${watch}`;
  if (conversation?.kind === "soir") systemPrompt += `\n\n${getEveningInstructions()}`;
  // The general "save his answer when he replies to a question you asked"
  // rule further up is already supposed to cover this, but it's buried in
  // a long prompt and relying on the model to apply it unprompted every
  // single time isn't good enough for a feature whose entire point is
  // learning something durable — so a 'question' conversation repeats it
  // here, unambiguous and right where it matters.
  if (conversation?.kind === "question") {
    systemPrompt +=
      "\n\n## Mode : question du jour\n" +
      "Cette conversation existe UNIQUEMENT parce que tu as posé à Mathéo une question pour mieux le connaître (c'est le premier message, déjà envoyé). " +
      "Dès qu'il répond, c'est ta priorité absolue : enregistre sa réponse immédiatement, avant toute autre chose — avec update_profile_section si ça rentre dans une section du profil, sinon avec update_assistant_notes. " +
      "Les deux sans demander la permission : c'est tout l'intérêt de cette conversation, une réponse non enregistrée ici est une question posée pour rien. " +
      "Sa réponse est souvent tapée vite, floue ou mal formulée : ne la recopie jamais telle quelle. Reformule-la en une version claire, précise et bien écrite qui garde exactement son sens, " +
      "comme tu l'écrirais toi-même si on te demandait son avis sur le sujet. Si elle est vraiment trop ambiguë pour être reformulée sans trahir ce qu'il voulait dire, repose une question de clarification avant d'enregistrer plutôt que de deviner. " +
      "Dis-lui ensuite en une ligne ce que tu as retenu (ta reformulation, pas sa phrase d'origine) avant de continuer la discussion si elle continue.";
  }

  const tools = toolDefinitions(!!conversationId);
  const workingMessages: any[] = [{ role: "system", content: systemPrompt }, ...history];

  try {
    let finalText = "";
    let usedWebTool = false;

    if (userMessage && isClaudeTrigger(userMessage)) {
      try {
        finalText = await askClaudeBridge(userMessage);
      } catch (err) {
        finalText = "Je n'ai pas pu joindre Claude Code : " + (err as Error).message;
      }
    } else {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const data = await callAiService({ messages: workingMessages, tools });
      const assistantMessage = data.choices?.[0]?.message;
      if (!assistantMessage) throw new Error("Réponse inattendue du modèle.");

      if (assistantMessage.tool_calls?.length) {
        workingMessages.push(assistantMessage);
        for (const call of assistantMessage.tool_calls) {
          if (call.function.name === "search_web" || call.function.name === "read_web_page") usedWebTool = true;
          const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
          const result = await executeTool(call.function.name, args, conversationId ?? null);
          workingMessages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
        continue;
      }

      finalText = assistantMessage.content || "";
      break;
    }

    if (!finalText) finalText = "Désolé, je n'ai pas réussi à formuler de réponse.";
    // Reserved for replies built from live internet research — exactly the
    // case most worth a second check (an invented or misread detail from a
    // page is easy, and hard to catch without rereading), and the one most
    // sessions won't hit, so this doesn't double the cost of every message.
    if (usedWebTool) finalText = await critiqueReply(userMessage || "(message avec image, sans texte)", finalText);
    }

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
