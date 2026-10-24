import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Check, CircleAlert, LockKeyhole, LogOut, MessageCircle, Phone, Plus, Search, Send, Settings2, ShieldCheck, Smartphone, Users, UsersRound, X } from "lucide-react";
import { api } from "./api.js";
import { createChatIdentity, decryptMessage, encryptMessage, getFingerprint, type ChatIdentity, type ChatMessage, type PublicIdentity } from "./chat/crypto.js";
import { loadIdentity, loadTrust, saveIdentity, saveTrust } from "./chat/key-store.js";

type ChatUser = { id: string; displayName: string; role: string; mustChangePassword: boolean };
type Contact = PublicIdentity & { id: string; displayName: string };
type Conversation = { id: string; createdAt: string; updatedAt: string; partner: Contact; lastMessage: ChatMessage | null };
type OpenConversation = Omit<Conversation, "lastMessage">;
type TrustState = { status: "unverified" | "verified" | "changed"; fingerprint: string };
type RenderedMessage = { message: ChatMessage; text?: string; failed?: boolean };

let identityInitializers = new Map<string, Promise<ChatIdentity>>();

function initializeIdentity(userId: string): Promise<ChatIdentity> {
  const pending = identityInitializers.get(userId);
  if (pending) return pending;
  const initialization = (async () => {
    const remote = await api<{ identity: PublicIdentity | null }>("/api/chat/identity");
    const local = await loadIdentity(userId);
    if (remote.identity) {
      if (!local) throw new Error("Cheia privată a acestui cont lipsește din browser. Nu poate fi recuperată de server.");
      if (local.ecdhPublicKey !== remote.identity.ecdhPublicKey || local.signingPublicKey !== remote.identity.signingPublicKey) {
        throw new Error("Cheile locale nu corespund identității contului. Chatul a fost oprit pentru a proteja conversațiile.");
      }
      return local;
    }
    const identity = local ?? await createChatIdentity();
    if (!local) await saveIdentity(userId, identity);
    await api("/api/chat/identity", { method: "POST", body: JSON.stringify({ ecdhPublicKey: identity.ecdhPublicKey, signingPublicKey: identity.signingPublicKey }) });
    return identity;
  })();
  identityInitializers.set(userId, initialization);
  void initialization.catch(() => identityInitializers.delete(userId));
  return initialization;
}

function displayTime(value: string) {
  return new Intl.DateTimeFormat("ro-RO", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function displayDay(value: string) {
  return new Intl.DateTimeFormat("ro-RO", { day: "numeric", month: "long" }).format(new Date(value));
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const known = new Set(current.map((message) => message.id));
  return [...current, ...incoming.filter((message) => !known.has(message.id))]
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() || left.id.localeCompare(right.id));
}

function ChatApp({ user, onLogout }: { user: ChatUser; onLogout: () => void }) {
  const [identity, setIdentity] = useState<ChatIdentity | null>(null);
  const [identityState, setIdentityState] = useState<"loading" | "ready" | "failed">("loading");
  const [identityError, setIdentityError] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<OpenConversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [renderedMessages, setRenderedMessages] = useState<RenderedMessage[]>([]);
  const [trust, setTrust] = useState<TrustState | null>(null);
  const [showFingerprint, setShowFingerprint] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [pageError, setPageError] = useState("");
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [directoryQuery, setDirectoryQuery] = useState("");
  const [conversationQuery, setConversationQuery] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [mobileConversationOpen, setMobileConversationOpen] = useState(false);
  const [streamState, setStreamState] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const selectedConversationId = useRef<string | null>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);

  useEffect(() => { selectedConversationId.current = selected?.id ?? null; }, [selected?.id]);

  useEffect(() => {
    let active = true;
    setIdentityState("loading");
    initializeIdentity(user.id).then((value) => {
      if (!active) return;
      setIdentity(value);
      setIdentityState("ready");
    }).catch((error) => {
      if (!active) return;
      setIdentityError(error instanceof Error ? error.message : "Identitatea criptografică nu a putut fi inițializată.");
      setIdentityState("failed");
    });
    return () => { active = false; };
  }, [user.id]);

  async function refreshConversations(showLoading = true) {
    if (showLoading) setLoadingConversations(true);
    try {
      const data = await api<{ conversations: Conversation[] }>("/api/chat/conversations");
      setConversations(data.conversations);
      if (selectedConversationId.current) {
        const current = data.conversations.find((conversation) => conversation.id === selectedConversationId.current);
        if (current) setSelected({ id: current.id, createdAt: current.createdAt, updatedAt: current.updatedAt, partner: current.partner });
      }
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Conversațiile nu s-au putut încărca.");
    } finally {
      if (showLoading) setLoadingConversations(false);
    }
  }

  useEffect(() => {
    if (identityState === "ready") void refreshConversations();
  // Conversation refresh is intentionally triggered when the identity becomes ready and after explicit actions.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityState]);

  useEffect(() => {
    if (identityState !== "ready") return;
    let active = true;
    const stream = new EventSource("/api/chat/events");
    const refreshSelectedMessages = (conversationId: string) => {
      void api<{ messages: ChatMessage[]; hasMore: boolean }>(`/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`)
        .then((data) => {
          if (!active) return;
          setMessages((current) => mergeMessages(current, data.messages));
          setHasOlderMessages(data.hasMore);
        })
        .catch(() => { /* EventSource reconnects and the selected conversation's fallback refresh recovers gaps. */ });
    };
    stream.onopen = () => {
      setStreamState("connected");
      const activeConversation = selectedConversationId.current;
      if (activeConversation) refreshSelectedMessages(activeConversation);
    };
    stream.onmessage = (event) => {
      let payload: unknown;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (!payload || typeof payload !== "object" || !("conversationId" in payload) || typeof payload.conversationId !== "string") return;
      void refreshConversations(false);
      if (payload.conversationId === selectedConversationId.current) refreshSelectedMessages(payload.conversationId);
    };
    stream.onerror = () => setStreamState("reconnecting");
    return () => {
      active = false;
      stream.close();
      setStreamState("connecting");
    };
  // One authenticated event stream serves the conversation list and whichever chat is open.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityState, user.id]);

  useEffect(() => {
    let active = true;
    if (!selected || !identity) {
      setMessages([]);
      setRenderedMessages([]);
      setTrust(null);
      return;
    }
    setLoadingMessages(true);
    setPageError("");
    Promise.all([
      api<{ messages: ChatMessage[]; hasMore: boolean }>(`/api/chat/conversations/${encodeURIComponent(selected.id)}/messages`),
      getFingerprint(selected.partner),
      loadTrust(selected.partner.id),
    ]).then(([data, fingerprint, savedTrust]) => {
      if (!active) return;
      setMessages(data.messages);
      setHasOlderMessages(data.hasMore);
      setTrust(!savedTrust ? { status: "unverified", fingerprint } : savedTrust.fingerprint === fingerprint ? { status: "verified", fingerprint } : { status: "changed", fingerprint });
    }).catch((error) => {
      if (active) setPageError(error instanceof Error ? error.message : "Mesajele nu s-au putut încărca.");
    }).finally(() => { if (active) setLoadingMessages(false); });
    const poll = window.setInterval(() => {
      api<{ messages: ChatMessage[]; hasMore: boolean }>(`/api/chat/conversations/${encodeURIComponent(selected.id)}/messages`)
        .then((data) => {
          if (!active) return;
          setMessages((current) => mergeMessages(current, data.messages));
          setHasOlderMessages(data.hasMore);
        })
        .catch(() => { /* A transient poll failure is recovered on the next interval. */ });
    }, 60_000);
    return () => { active = false; window.clearInterval(poll); };
  }, [selected?.id, selected?.partner.id, selected?.partner.ecdhPublicKey, selected?.partner.signingPublicKey, identity]);

  useEffect(() => {
    let active = true;
    if (!identity || !selected || trust?.status !== "verified") {
      setRenderedMessages(messages.map((message) => ({ message })));
      return;
    }
    Promise.all(messages.map(async (message) => {
      try {
        const expectedSender = message.senderId === user.id ? identity : selected.partner;
        if (message.senderEcdhPublicKey !== expectedSender.ecdhPublicKey || message.senderSigningPublicKey !== expectedSender.signingPublicKey) {
          throw new Error("Cheia semnatarului nu corespunde identității verificate.");
        }
        const text = await decryptMessage({ message, localUserId: user.id, identity, partner: selected.partner });
        return { message, text } satisfies RenderedMessage;
      } catch {
        return { message, failed: true } satisfies RenderedMessage;
      }
    })).then((items) => { if (active) setRenderedMessages(items); });
    return () => { active = false; };
  }, [messages, identity, selected, trust?.status, user.id]);

  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [renderedMessages, selected?.id]);

  useEffect(() => {
    let active = true;
    if (!directoryOpen || directoryQuery.trim().length < 2) {
      setContacts([]);
      return;
    }
    setLoadingContacts(true);
    const timer = window.setTimeout(() => {
      api<{ contacts: Contact[] }>(`/api/chat/contacts?q=${encodeURIComponent(directoryQuery.trim())}`)
        .then((data) => { if (active) setContacts(data.contacts); })
        .catch((error) => { if (active) setPageError(error instanceof Error ? error.message : "Lista de contacte nu s-a putut încărca."); })
        .finally(() => { if (active) setLoadingContacts(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [directoryOpen, directoryQuery]);

  async function chooseConversation(conversation: Conversation) {
    setSelected({ id: conversation.id, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, partner: conversation.partner });
    setMessages([]);
    setTrust(null);
    setShowFingerprint(false);
    setHasOlderMessages(false);
    setMobileConversationOpen(true);
    setDirectoryOpen(false);
  }

  async function startConversation(contact: Contact) {
    setPageError("");
    try {
      const result = await api<{ conversation: { id: string } }>("/api/chat/conversations", { method: "POST", body: JSON.stringify({ userId: contact.id }) });
      const data = await api<{ conversations: Conversation[] }>("/api/chat/conversations");
      setConversations(data.conversations);
      const conversation = data.conversations.find((item) => item.id === result.conversation.id);
      if (conversation) await chooseConversation(conversation);
      else setPageError("Conversația a fost creată, dar nu s-a putut încărca.");
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Conversația nu a putut fi pornită.");
    }
  }

  async function confirmFingerprint() {
    if (!selected || !trust) return;
    const accepted = window.confirm(`Compară acest cod cu persoana, printr-un canal separat. Confirmă doar dacă se potrivește exact:\n\n${trust.fingerprint}\n\nAi verificat codul cu ${selected.partner.displayName}?`);
    if (!accepted) return;
    await saveTrust(selected.partner.id, trust.fingerprint);
    setTrust({ ...trust, status: "verified" });
    setShowFingerprint(false);
  }

  async function loadOlderMessages() {
    if (!selected || !messages.length || !hasOlderMessages || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const first = messages[0];
      if (!first) return;
      const data = await api<{ messages: ChatMessage[]; hasMore: boolean }>(`/api/chat/conversations/${encodeURIComponent(selected.id)}/messages?beforeId=${encodeURIComponent(first.id)}`);
      setMessages((current) => {
        const known = new Set(current.map((message) => message.id));
        return [...data.messages.filter((message) => !known.has(message.id)), ...current];
      });
      setHasOlderMessages(data.hasMore);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Mesajele mai vechi nu s-au putut încărca.");
    } finally {
      setLoadingOlder(false);
    }
  }

  async function submitMessage(event: FormEvent) {
    event.preventDefault();
    if (!identity || !selected || trust?.status !== "verified" || !composer.trim() || sending) return;
    const text = composer.trim();
    if (text.length > 4000) { setPageError("Mesajul poate avea cel mult 4.000 de caractere."); return; }
    setSending(true);
    setPageError("");
    try {
      const envelope = await encryptMessage({
        text,
        conversationId: selected.id,
        senderId: user.id,
        recipientId: selected.partner.id,
        identity,
        recipient: selected.partner,
      });
      const result = await api<{ message: ChatMessage }>(`/api/chat/conversations/${encodeURIComponent(selected.id)}/messages`, {
        method: "POST",
        body: JSON.stringify(envelope),
      });
      setMessages((current) => mergeMessages(current, [result.message]));
      setComposer("");
      void refreshConversations();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Mesajul criptat nu a putut fi trimis.");
    } finally {
      setSending(false);
    }
  }

  function retryIdentity() {
    setIdentityError("");
    setIdentityState("loading");
    identityInitializers.delete(user.id);
    void initializeIdentity(user.id).then((value) => { setIdentity(value); setIdentityState("ready"); }).catch((error) => {
      setIdentityError(error instanceof Error ? error.message : "Identitatea nu a putut fi verificată.");
      setIdentityState("failed");
    });
  }

  const visibleConversations = conversations.filter((conversation) => conversation.partner.displayName.toLocaleLowerCase("ro").includes(conversationQuery.trim().toLocaleLowerCase("ro")));

  if (identityState === "loading") return <main className="chat-loading"><div className="chat-loading-mark"><LockKeyhole size={22} /></div><strong>Pregătim conversațiile criptate</strong><span>Cheile private rămân în acest browser.</span></main>;
  if (identityState === "failed") return <main className="chat-security-block"><div className="chat-security-mark"><CircleAlert size={25} /></div><span className="chat-overline">PROTECȚIA IDENTITĂȚII</span><h1>Chatul este oprit</h1><p>{identityError}</p><div className="chat-security-note"><LockKeyhole size={16} /> Serverul nu păstrează copii de rezervă ale cheilor private.</div><div className="chat-security-actions"><button className="chat-button chat-button-outline" onClick={retryIdentity}>Verifică din nou</button><button className="chat-button chat-button-dark" onClick={onLogout}><LogOut size={16} /> Ieși din cont</button></div></main>;

  return <main className={`chat-app ${mobileConversationOpen ? "chat-app-open" : ""}`}>
    <nav className="chat-rail" aria-label="Navigare principală">
      <div className="chat-rail-brand" aria-label="ChaTiganu"><span><MessageCircle size={19} /></span><strong>ChaTiganu</strong></div>
      <div className="chat-rail-nav">
        <button className="chat-rail-link chat-rail-link-active" aria-label="Chaturi" title="Chaturi" onClick={() => setMobileConversationOpen(false)}><MessageCircle size={19} /><span>Chaturi</span></button>
        <button className="chat-rail-link" aria-label="Contacte" title="Caută persoane" onClick={() => { setDirectoryQuery(""); setContacts([]); setDirectoryOpen(true); }}><UsersRound size={19} /><span>Contacte</span></button>
        <div className="chat-rail-link chat-rail-link-disabled" aria-disabled="true" title="Conversațiile de grup nu sunt disponibile încă."><Users size={19} /><span>Grupuri</span></div>
        <div className="chat-rail-link chat-rail-link-disabled" aria-disabled="true" title="Apelurile audio și video nu sunt disponibile încă."><Phone size={19} /><span>Apeluri</span></div>
        <div className="chat-rail-link chat-rail-link-disabled" aria-disabled="true" title="Setările suplimentare nu sunt disponibile încă."><Settings2 size={19} /><span>Setări</span></div>
      </div>
      <div className="chat-rail-bottom"><span className="chat-rail-secure" title="Sesiune autentificată"><ShieldCheck size={17} /></span><button className="chat-rail-link" aria-label="Ieși din cont" title="Ieși din cont" onClick={onLogout}><LogOut size={18} /><span>Ieșire</span></button></div>
    </nav>
    <aside className="chat-sidebar">
      <header className="chat-sidebar-head"><span className="chat-sidebar-kicker"><span className="chat-live-dot" /> SPAȚIU PRIVAT</span><span className={`chat-sidebar-encryption chat-stream-${streamState}`} aria-live="polite" title={streamState === "connected" ? "Primești mesaje imediat" : "Mesajele se sincronizează automat"}><LockKeyhole size={13} />{streamState === "connected" ? "Criptat · Live" : streamState === "reconnecting" ? "Criptat · Reconectare" : "Criptat · Conectare"}</span></header>
      <div className="chat-sidebar-title"><div><span className="chat-overline">MESAGERIE</span><h1>Conversații</h1></div><button className="chat-new-button" onClick={() => { setDirectoryQuery(""); setContacts([]); setDirectoryOpen(true); }} aria-label="Conversație nouă"><Plus size={18} /></button></div>
      <div className="chat-sidebar-search"><Search size={16} /><input aria-label="Caută conversații" placeholder="Caută conversații" value={conversationQuery} onChange={(event) => setConversationQuery(event.target.value)} /></div>
      <div className="chat-conversation-list">
        {loadingConversations ? <div className="chat-list-placeholder">Se încarcă conversațiile...</div> : conversations.length === 0 ? <div className="chat-empty-list"><span><MessageCircle size={19} /></span><strong>Încă nu ai conversații</strong><p>Caută un utilizator pentru a începe un chat criptat.</p><button className="chat-text-button" onClick={() => setDirectoryOpen(true)}>Caută persoane <ArrowLeft size={14} /></button></div> : visibleConversations.length === 0 ? <div className="chat-list-placeholder">Nu există conversații cu acest nume.</div> : visibleConversations.map((conversation) => <button key={conversation.id} className={`chat-conversation-item ${selected?.id === conversation.id ? "chat-conversation-active" : ""}`} onClick={() => void chooseConversation(conversation)}>
          <span className="chat-avatar">{conversation.partner.displayName.slice(0, 1).toLocaleUpperCase("ro")}</span><span className="chat-conversation-copy"><strong>{conversation.partner.displayName}</strong><small><LockKeyhole size={11} /> Mesaje criptate</small></span><span className="chat-conversation-meta">{conversation.lastMessage ? displayTime(conversation.lastMessage.createdAt) : ""}</span>
        </button>)}
      </div>
      <footer className="chat-account-card"><span className="chat-account-avatar">{user.displayName.slice(0, 1).toLocaleUpperCase("ro")}</span><span><strong>{user.displayName}</strong><small>Cont securizat</small></span><span className="chat-account-lock"><ShieldCheck size={16} /></span></footer>
    </aside>

    <section className="chat-main">
      {selected ? <>
        <header className="chat-conversation-head"><button className="chat-icon-button chat-back-button" aria-label="Înapoi la conversații" onClick={() => setMobileConversationOpen(false)}><ArrowLeft size={18} /></button><span className="chat-avatar chat-avatar-small">{selected.partner.displayName.slice(0, 1).toLocaleUpperCase("ro")}</span><div className="chat-conversation-heading"><strong>{selected.partner.displayName}</strong><span><LockKeyhole size={12} /> Criptare activă pe dispozitivele participanților</span></div><button className="chat-icon-button chat-header-security" title="Amprentă de securitate" aria-label="Afișează amprenta de securitate" onClick={() => setShowFingerprint((current) => !current)}><ShieldCheck size={18} /></button></header>
        {pageError && <div className="chat-inline-error"><CircleAlert size={16} /><span>{pageError}</span><button aria-label="Închide" onClick={() => setPageError("")}><X size={15} /></button></div>}
        {trust && (trust.status !== "verified" || showFingerprint) && <div className={`chat-fingerprint-banner ${trust.status === "changed" ? "chat-fingerprint-changed" : ""}`}><span className="chat-fingerprint-icon"><ShieldCheck size={17} /></span><div><strong>{trust.status === "verified" ? "Amprentă verificată" : trust.status === "changed" ? "Amprenta de securitate s-a schimbat" : "Verifică identitatea înainte de a conversa"}</strong><p>Compară acest cod cu persoana, printr-un apel sau față în față. Fără verificare, serverul ar putea substitui cheia publică.</p><code>{trust.fingerprint}</code></div>{trust.status === "verified" ? <button className="chat-button chat-button-verify" onClick={() => setShowFingerprint(false)}>Ascunde</button> : <button className="chat-button chat-button-verify" onClick={() => void confirmFingerprint()}>{trust.status === "changed" ? "Verifică din nou" : "Am comparat codul"}</button>}</div>}
        <div className="chat-message-list">
          {hasOlderMessages && messages.length > 0 && <button className="chat-load-older" onClick={() => void loadOlderMessages()} disabled={loadingOlder}>{loadingOlder ? "Se încarcă..." : "Încarcă mesajele mai vechi"}</button>}
          {loadingMessages ? <div className="chat-message-empty">Se încarcă mesajele...</div> : messages.length === 0 ? <div className="chat-message-empty"><span><LockKeyhole size={22} /></span><strong>Conversație privată</strong><p>Mesajele se criptează în browser înainte să ajungă la server.</p></div> : renderedMessages.map((item, index) => {
            const previous = renderedMessages[index - 1]?.message;
            const showDay = !previous || new Date(previous.createdAt).toDateString() !== new Date(item.message.createdAt).toDateString();
            const mine = item.message.senderId === user.id;
            return <div key={item.message.id}>
              {showDay && <div className="chat-date-divider"><span>{displayDay(item.message.createdAt)}</span></div>}
              <article className={`chat-message-row ${mine ? "chat-message-mine" : ""}`}>
                {!mine && <span className="chat-message-avatar">{selected.partner.displayName.slice(0, 1).toLocaleUpperCase("ro")}</span>}
                <div className="chat-message-bubble">{item.failed ? <span className="chat-message-failed"><CircleAlert size={14} /> Mesajul nu a trecut verificarea criptografică.</span> : trust?.status === "verified" ? <p>{item.text}</p> : <span className="chat-message-locked"><LockKeyhole size={14} /> Conținut ascuns până la verificarea identității.</span>}<time>{displayTime(item.message.createdAt)}{mine && <Check size={12} />}</time></div>
              </article>
            </div>;
          })}
          <div ref={messagesEnd} />
        </div>
        <form className="chat-composer" onSubmit={(event) => void submitMessage(event)}><div className="chat-composer-wrap"><textarea aria-label="Mesaj" placeholder={trust?.status === "verified" ? "Scrie un mesaj privat..." : "Verifică amprenta pentru a trimite mesaje"} value={composer} onChange={(event) => setComposer(event.target.value)} disabled={trust?.status !== "verified" || sending} maxLength={4000} rows={1} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button type="submit" disabled={trust?.status !== "verified" || sending || !composer.trim()} aria-label="Trimite mesajul">{sending ? <span className="chat-send-spinner" /> : <Send size={17} />}</button></div><div className="chat-composer-foot"><span><LockKeyhole size={12} /> Criptat înainte de trimitere · API-ul primește doar pachetul criptat</span><span>{composer.length}/4000</span></div></form>
      </> : <div className="chat-welcome"><div className="chat-welcome-orb"><MessageCircle size={27} /></div><span className="chat-overline">CHATIGANU · CHAT PRIVAT</span><h2>Confidențialitatea<br /><em>începe pe dispozitiv.</em></h2><p>Mesajele sunt criptate în browser înainte de trimitere. Începe o conversație sau selectează una existentă.</p><button className="chat-button chat-button-dark" onClick={() => setDirectoryOpen(true)}><Plus size={16} /> Începe o conversație</button><div className="chat-welcome-security"><ShieldCheck size={15} /> Verifică amprenta contactului înainte să trimiți date sensibile.</div></div>}
      {!selected && pageError && <div className="chat-floating-error"><CircleAlert size={16} />{pageError}<button aria-label="Închide" onClick={() => setPageError("")}><X size={15} /></button></div>}
    </section>

    <aside className="chat-details" aria-label="Detalii conversație">
      {selected ? <div className="chat-details-scroll">
        <div className="chat-contact-card"><span className="chat-contact-avatar">{selected.partner.displayName.slice(0, 1).toLocaleUpperCase("ro")}</span><strong>{selected.partner.displayName}</strong><span className="chat-contact-state"><span className="chat-live-dot" /> Identitate disponibilă</span><button className="chat-detail-action" onClick={() => setShowFingerprint(true)}><ShieldCheck size={16} /> Verifică identitatea</button></div>
        <section className="chat-detail-section"><div className="chat-detail-heading"><span>Securitatea conversației</span><ShieldCheck size={15} /></div><div className="chat-detail-security"><LockKeyhole size={17} /><div><strong>Criptare pe dispozitive</strong><p>Mesajele sunt criptate în browser. Serverul păstrează doar pachetele criptate.</p></div></div>
          {trust && <div className={`chat-trust-state ${trust.status === "verified" ? "is-verified" : trust.status === "changed" ? "is-changed" : ""}`}><span />{trust.status === "verified" ? "Amprentă verificată" : trust.status === "changed" ? "Amprenta s-a schimbat" : "Amprentă neverificată"}</div>}
          {trust?.status === "verified" && <button className="chat-fingerprint-toggle" onClick={() => setShowFingerprint((current) => !current)}>{showFingerprint ? "Ascunde amprenta" : "Afișează amprenta"}</button>}
        </section>
        <section className="chat-detail-section"><div className="chat-detail-heading"><span>Fișiere și media</span></div><div className="chat-detail-unavailable">În acest moment sunt disponibile doar mesaje text. Trimiterea de fișiere nu este implementată.</div></section>
        <section className="chat-detail-section"><div className="chat-detail-heading"><span>Apeluri</span></div><div className="chat-detail-unavailable">Apelurile audio și video nu sunt încă disponibile în aplicație.</div></section>
      </div> : <div className="chat-details-empty"><ShieldCheck size={22} /><strong>Conversație securizată</strong><p>Selectează o conversație pentru a vedea detaliile reale ale identității și protecției.</p></div>}
    </aside>
    {directoryOpen && <div className="chat-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDirectoryOpen(false); }}><section className="chat-directory-modal" role="dialog" aria-modal="true" aria-labelledby="chat-directory-title"><header><div><span className="chat-overline">CONTACTE ACTIVE</span><h2 id="chat-directory-title">Conversație nouă</h2></div><button className="chat-icon-button" aria-label="Închide" onClick={() => setDirectoryOpen(false)}><X size={18} /></button></header><div className="chat-directory-search"><Search size={17} /><input autoFocus value={directoryQuery} onChange={(event) => setDirectoryQuery(event.target.value)} placeholder="Caută după nume (minimum 2 litere)" /></div><div className="chat-directory-results">{directoryQuery.trim().length < 2 ? <div className="chat-directory-hint"><Smartphone size={18} /><span>Caută după nume. Numerele de telefon nu sunt afișate.</span></div> : loadingContacts ? <div className="chat-directory-hint">Se caută...</div> : contacts.length === 0 ? <div className="chat-directory-hint">Nu am găsit conturi active cu chei de chat inițializate.</div> : contacts.map((contact) => <button key={contact.id} className="chat-directory-contact" onClick={() => void startConversation(contact)}><span className="chat-avatar">{contact.displayName.slice(0, 1).toLocaleUpperCase("ro")}</span><span><strong>{contact.displayName}</strong><small><LockKeyhole size={12} /> Identitate criptografică disponibilă</small></span><Plus size={17} /></button>)}</div><footer><LockKeyhole size={14} /> Contactele trebuie să fi deschis chatul cel puțin o dată.</footer></section></div>}
  </main>;
}

export default ChatApp;
