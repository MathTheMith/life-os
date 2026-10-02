import { useState, useRef, useEffect, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  sendChat,
  describeImage,
  fetchConversations,
  createConversation,
  fetchConversationMessages,
  deleteConversation,
  openEveningChat,
  finishEveningChat,
  type ChatMessage,
  type Conversation,
} from '../api'
import { SendIcon, HistoryIcon, PlusIcon, CloseIcon, TrashIcon, ImageIcon, MoonIcon } from '../icons'
import { resizeImageFile } from '../imageResize'

// Wide GFM tables need their own horizontal scroll — otherwise a 5-column
// plan table blows out the chat bubble width on mobile.
const markdownComponents = {
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
}

// Memoized so typing in the textarea (which re-renders Chat on every key)
// doesn't re-parse the markdown of every previous message.
const MessageBubble = memo(function MessageBubble({ role, content, image }: ChatMessage) {
  return (
    <div className={`chat-bubble chat-bubble--${role}`}>
      {image && <img src={image} alt="" className="chat-bubble-image" />}
      {role === 'assistant' ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {content}
        </ReactMarkdown>
      ) : (
        content
      )}
    </div>
  )
})

type ActiveChat =
  | { kind: 'temporary'; messages: ChatMessage[] }
  | { kind: 'saved'; id: number; title: string; messages: ChatMessage[]; evening?: boolean }

const RELATIVE_FORMAT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' })
function formatDate(iso: string): string {
  return RELATIVE_FORMAT.format(new Date(iso.replace(' ', 'T') + 'Z'))
}

export function Chat({ openEvening = false, openConversationId }: { openEvening?: boolean; openConversationId?: number }) {
  const [activeChat, setActiveChat] = useState<ActiveChat>({ kind: 'temporary', messages: [] })
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [showNewChatPicker, setShowNewChatPicker] = useState(false)
  const [conversations, setConversations] = useState<Conversation[] | null>(null)
  const [attachedImage, setAttachedImage] = useState<{ preview: string; description: string } | null>(null)
  const [analyzingImage, setAnalyzingImage] = useState(false)
  const messagesRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const messages = activeChat.messages

  useEffect(() => {
    if (messages.length === 0 && !loading) return
    const el = messagesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, loading])

  // Tapping the input to type an answer opens the on-screen keyboard, which
  // shrinks the visible viewport — the messages pane keeps its old
  // scrollTop, so what was at the bottom (the AI's latest message, right
  // above the input) ends up hidden below the fold with no scroll
  // triggered automatically. Re-scrolling to bottom on every viewport
  // resize (keyboard open/close) keeps it in view.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const onResize = () => {
      const el = messagesRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
    vv.addEventListener('resize', onResize)
    return () => vv.removeEventListener('resize', onResize)
  }, [])

  async function openHistory() {
    setShowHistory(true)
    try {
      setConversations(await fetchConversations())
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function openConversation(conv: Conversation) {
    setShowHistory(false)
    setError(null)
    try {
      const msgs = await fetchConversationMessages(conv.id)
      setActiveChat({ kind: 'saved', id: conv.id, title: conv.title, messages: msgs, evening: conv.kind === 'soir' })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function handleDeleteConversation(id: number, e: React.MouseEvent) {
    e.stopPropagation()
    await deleteConversation(id)
    setConversations((prev) => prev?.filter((c) => c.id !== id) ?? null)
    if (activeChat.kind === 'saved' && activeChat.id === id) {
      setActiveChat({ kind: 'temporary', messages: [] })
    }
  }

  function startTemporaryChat() {
    setShowNewChatPicker(false)
    setActiveChat({ kind: 'temporary', messages: [] })
  }

  async function startSavedChat() {
    setShowNewChatPicker(false)
    setError(null)
    try {
      const { id } = await createConversation()
      setActiveChat({ kind: 'saved', id, title: 'Nouvelle conversation', messages: [] })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // Opened from the evening reminder notification, or from the question of
  // the day (a conversation the AI already started).
  useEffect(() => {
    if (openConversationId) {
      fetchConversationMessages(openConversationId)
        .then((msgs) => setActiveChat({ kind: 'saved', id: openConversationId, title: 'Question du jour', messages: msgs }))
        .catch((err) => setError((err as Error).message))
    } else if (openEvening) startEveningChat()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function startEveningChat() {
    setError(null)
    try {
      const { id, title } = await openEveningChat()
      const msgs = await fetchConversationMessages(id)
      setActiveChat({ kind: 'saved', id, title, messages: msgs, evening: true })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function handleFinishEvening() {
    if (activeChat.kind !== 'saved' || loading) return
    setLoading(true)
    setError(null)
    try {
      const recap = await finishEveningChat(activeChat.id)
      setActiveChat((prev) => ({ ...prev, messages: [...prev.messages, { role: 'assistant', content: recap }] }) as ActiveChat)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function handlePickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // lets picking the same file twice re-trigger onChange
    if (!file) return
    setError(null)
    setAnalyzingImage(true)
    try {
      const preview = await resizeImageFile(file)
      // Described right away, before Send is even usable — the description
      // is what actually gets sent on this and every later turn, so it
      // needs to exist before there's anything to send at all.
      const description = await describeImage(preview)
      setAttachedImage({ preview, description })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setAnalyzingImage(false)
    }
  }

  async function handleSend() {
    const text = input.trim()
    if ((!text && !attachedImage) || loading || analyzingImage) return

    const userMsg: ChatMessage = {
      role: 'user',
      content: text,
      image: attachedImage?.preview,
      imageDescription: attachedImage?.description,
    }
    const nextMessages = [...messages, userMsg]
    setActiveChat((prev) => ({ ...prev, messages: nextMessages }) as ActiveChat)
    setInput('')
    setAttachedImage(null)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setLoading(true)
    setError(null)

    try {
      const reply =
        activeChat.kind === 'saved'
          ? await sendChat({
              conversationId: activeChat.id,
              message: text,
              image: userMsg.image,
              imageDescription: userMsg.imageDescription,
            })
          : await sendChat({ messages: nextMessages })

      setActiveChat((prev) => ({ ...prev, messages: [...nextMessages, { role: 'assistant', content: reply }] }) as ActiveChat)

      // First exchange in a saved chat auto-titles itself server-side —
      // pick that up so the header doesn't keep showing the placeholder.
      if (activeChat.kind === 'saved' && activeChat.title === 'Nouvelle conversation') {
        fetchConversations()
          .then((list) => {
            const updated = list.find((c) => c.id === (activeChat as { id: number }).id)
            if (updated) setActiveChat((prev) => (prev.kind === 'saved' ? { ...prev, title: updated.title } : prev))
          })
          .catch(() => {})
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="chat">
      <div className="chat-topbar">
        <button className="icon-button" onClick={openHistory} aria-label="Historique des conversations">
          <HistoryIcon size={16} />
        </button>
        <span className="chat-topbar-title">
          {activeChat.kind === 'saved' ? activeChat.title : 'Discussion temporaire'}
        </span>
        <div className="chat-topbar-actions">
          <button className="icon-button" onClick={startEveningChat} aria-label="Chat du soir">
            <MoonIcon size={16} />
          </button>
          <button className="icon-button" onClick={() => setShowNewChatPicker(true)} aria-label="Nouvelle conversation">
            <PlusIcon size={16} />
          </button>
        </div>
      </div>

      <div className="chat-messages" ref={messagesRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Pose une question sur ton budget, tes dépenses, ou autre chose.</p>
            <p className="chat-empty-note">
              {activeChat.kind === 'temporary'
                ? "Discussion temporaire — elle disparaît si tu recharges la page ou changes de chat."
                : 'Cette conversation est sauvegardée.'}
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={i} role={m.role} content={m.content} image={m.image} />
        ))}
        {loading && (
          <div className="chat-bubble chat-bubble--assistant chat-bubble--typing">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </div>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {activeChat.kind === 'saved' && activeChat.evening && messages.some((m) => m.role === 'user') && (
        <button className="text-button chat-finish-evening" onClick={handleFinishEvening} disabled={loading}>
          📓 Terminer et enregistrer mon journal
        </button>
      )}
      {(attachedImage || analyzingImage) && (
        <div className="chat-attachment-preview">
          {attachedImage ? (
            <img src={attachedImage.preview} alt="" />
          ) : (
            <div className="chat-attachment-spinner" aria-hidden="true" />
          )}
          <span className="chat-attachment-status">
            {analyzingImage ? 'Analyse de l’image…' : 'Image prête'}
          </span>
          {attachedImage && (
            <button type="button" className="icon-button" onClick={() => setAttachedImage(null)} aria-label="Retirer l'image">
              <CloseIcon size={14} />
            </button>
          )}
        </div>
      )}
      <div className="chat-input-row">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={handlePickImage}
        />
        <button
          type="button"
          className="icon-button chat-attach-button"
          disabled={analyzingImage}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Joindre une image"
        >
          <ImageIcon size={18} />
        </button>
        <textarea
          ref={textareaRef}
          className="chat-input"
          value={input}
          onFocus={() => {
            // Immediate nudge — the visualViewport resize listener above
            // also catches this, but only once the keyboard animation
            // actually finishes, which can lag a beat behind the tap.
            const el = messagesRef.current
            if (el) el.scrollTop = el.scrollHeight
          }}
          onChange={(e) => {
            setInput(e.target.value)
            const el = e.target
            el.style.height = 'auto'
            el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.5)}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          placeholder="Écris un message…"
          rows={1}
        />
        <button className="send-button" onClick={handleSend} disabled={loading || analyzingImage} aria-label="Envoyer">
          <SendIcon />
        </button>
      </div>

      {showHistory && (
        <div className="modal-backdrop" onClick={() => setShowHistory(false)}>
          <div className="modal-panel glass-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Conversations</h2>
              <button type="button" className="icon-button" onClick={() => setShowHistory(false)} aria-label="Fermer">
                <CloseIcon size={18} />
              </button>
            </div>

            {conversations === null && <p className="pie-empty">Chargement…</p>}
            {conversations && conversations.length === 0 && (
              <p className="pie-empty">Aucune conversation sauvegardée pour l'instant.</p>
            )}
            {conversations && conversations.length > 0 && (
              <ul className="conversation-list">
                {conversations.map((c) => (
                  <li key={c.id} className="conversation-row" onClick={() => openConversation(c)}>
                    <div className="conversation-row-main">
                      <span className="conversation-row-title">{c.title}</span>
                      <span className="conversation-row-date">{formatDate(c.updated_at)}</span>
                    </div>
                    {!c.protected && (
                      <button
                        className="icon-action-button icon-action-button--danger"
                        onClick={(e) => handleDeleteConversation(c.id, e)}
                        aria-label="Supprimer la conversation"
                      >
                        <TrashIcon size={16} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {showNewChatPicker && (
        <div className="modal-backdrop" onClick={() => setShowNewChatPicker(false)}>
          <div className="modal-panel glass-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Nouvelle conversation</h2>
              <button type="button" className="icon-button" onClick={() => setShowNewChatPicker(false)} aria-label="Fermer">
                <CloseIcon size={18} />
              </button>
            </div>
            <div className="modal-form">
              <button className="primary-button" onClick={startSavedChat}>
                Sauvegardée
              </button>
              <button className="text-button" onClick={startTemporaryChat} style={{ alignSelf: 'center', marginTop: 4 }}>
                Ou démarrer une discussion temporaire
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
