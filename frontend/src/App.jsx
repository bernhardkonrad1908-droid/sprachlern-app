import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send, Sparkles, Globe2, Languages, RotateCcw, Loader2, BookOpen,
  Mic, Volume2, VolumeX, BookMarked, MessageSquare, X, Plus, Check, Trash2,
  Headphones, RefreshCw, Award, ArrowRightLeft, Save, ListMusic,
} from "lucide-react";

// Wichtig: API-Endpoint zeigt jetzt auf den Backend-Proxy, nicht direkt zu Anthropic
const API_URL = "/api/messages";
const MODEL = "claude-sonnet-4-5";

const LANGUAGES = [
  { code: "en", name: "Englisch",       native: "English",    flag: "🇬🇧", bcp47: "en-GB" },
  { code: "es", name: "Spanisch",       native: "Español",    flag: "🇪🇸", bcp47: "es-ES" },
  { code: "fr", name: "Französisch",    native: "Français",   flag: "🇫🇷", bcp47: "fr-FR" },
  { code: "it", name: "Italienisch",    native: "Italiano",   flag: "🇮🇹", bcp47: "it-IT" },
  { code: "pt", name: "Portugiesisch",  native: "Português",  flag: "🇵🇹", bcp47: "pt-PT" },
  { code: "nl", name: "Niederländisch", native: "Nederlands", flag: "🇳🇱", bcp47: "nl-NL" },
  { code: "sv", name: "Schwedisch",     native: "Svenska",    flag: "🇸🇪", bcp47: "sv-SE" },
  { code: "ja", name: "Japanisch",      native: "日本語",      flag: "🇯🇵", bcp47: "ja-JP" },
];

const LEVELS = [
  { code: "A1", name: "Anfänger",       desc: "Einfache Sätze, Grundwortschatz, Gegenwart" },
  { code: "A2", name: "Grundlagen",     desc: "Alltagssprache, einfache Vergangenheit" },
  { code: "B1", name: "Mittelstufe",    desc: "Meinungen ausdrücken, alle Zeiten" },
  { code: "B2", name: "Fortgeschritten",desc: "Nuancen, komplexe Strukturen" },
  { code: "C1", name: "Fließend",       desc: "Idiomatik, präzise Ausdrucksweise" },
];

const TOPICS = [
  "Reisen & Urlaub", "Essen & Kochen", "Beruf & Alltag",
  "Hobbys & Sport", "Kunst & Kultur", "Aktuelles & Politik",
];

// ─── Vergleichslogik ─────────────────────────────
const levenshtein = (a, b) => {
  const m = Array.from({ length: b.length + 1 }, () => Array(a.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) m[0][i] = i;
  for (let j = 0; j <= b.length; j++) m[j][0] = j;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      m[j][i] = b[j - 1] === a[i - 1]
        ? m[j - 1][i - 1]
        : 1 + Math.min(m[j - 1][i], m[j][i - 1], m[j - 1][i - 1]);
    }
  }
  return m[b.length][a.length];
};

const normalize = (s) =>
  (s || "").toLowerCase()
    .replace(/[.,!?;:¿¡()«»""''""…\-—–]/g, "")
    .replace(/\s+/g, " ").trim();

const compareShadowing = (original, spoken) => {
  const origWords = normalize(original).split(" ").filter(Boolean);
  const spokenWords = normalize(spoken).split(" ").filter(Boolean);
  const spokenSet = new Set(spokenWords);
  const words = origWords.map((w, i) => {
    const sw = spokenWords[i] || "";
    if (sw === w) return { word: w, status: "correct" };
    const threshold = Math.max(1, Math.floor(w.length * 0.25));
    if (sw && levenshtein(w, sw) <= threshold) return { word: w, status: "close" };
    if (spokenSet.has(w)) return { word: w, status: "shifted" };
    return { word: w, status: "missing" };
  });
  const c = words.filter((w) => w.status === "correct").length;
  const cl = words.filter((w) => w.status === "close").length;
  const sh = words.filter((w) => w.status === "shifted").length;
  const score = origWords.length === 0 ? 0
    : Math.round(((c + cl * 0.7 + sh * 0.4) / origWords.length) * 100);
  return { words, score };
};

export default function App() {
  const [setupDone, setSetupDone] = useState(false);
  const [language, setLanguage] = useState(LANGUAGES[1]);
  const [level, setLevel] = useState(LEVELS[1]);
  const [topic, setTopic] = useState("");

  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState("");
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState("");
  const [translations, setTranslations] = useState({});
  const [translatingIdx, setTranslatingIdx] = useState(null);

  const [activeTab, setActiveTab] = useState("chat");
  const [wordPopup, setWordPopup] = useState(null);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [translateMode, setTranslateMode] = useState(false);
  const [translatingInput, setTranslatingInput] = useState(false);
  const [phraseMode, setPhraseMode] = useState(false);
  const [creatingPhrase, setCreatingPhrase] = useState(false);
  const [currentPhrase, setCurrentPhrase] = useState(null); // {id, german, target}
  const [phrases, setPhrases] = useState([]);

  const [recording, setRecording] = useState(false);
  const [speakingId, setSpeakingId] = useState(null);
  const [ttsUnlocked, setTtsUnlocked] = useState(false);
  const recognitionRef = useRef(null);
  const recognitionModeRef = useRef(null);
  const userStoppedRef = useRef(false);
  const inputBaseRef = useRef("");
  const sessionFinalRef = useRef("");
  const sessionInterimRef = useRef("");
  const restartCooldownRef = useRef(0);
  const lastSessionFinalTextRef = useRef("");      // Letzter final-Text der vorherigen Session (für Echo-Schutz)
  const isFirstFinalAfterRestartRef = useRef(false);
  const speechSupported = typeof window !== "undefined" &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);
  const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;

  const [shadowing, setShadowing] = useState(null);
  const shadowingRef = useRef(null);
  shadowingRef.current = shadowing;

  const [vocab, setVocab] = useState([]);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const lastAutoSpokenIdxRef = useRef(-1);

  // Vokabel-Persistenz (jetzt erlaubt, weil eigene Domain)
  useEffect(() => {
    try {
      const stored = localStorage.getItem("vocab");
      if (stored) setVocab(JSON.parse(stored));
    } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem("vocab", JSON.stringify(vocab)); } catch {}
  }, [vocab]);

  // Phrasen-Persistenz
  useEffect(() => {
    try {
      const stored = localStorage.getItem("phrases_v1");
      if (stored) setPhrases(JSON.parse(stored));
    } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem("phrases_v1", JSON.stringify(phrases)); } catch {}
  }, [phrases]);

  // Recognition
  useEffect(() => {
    if (!speechSupported) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (event) => {
      if (Date.now() < restartCooldownRef.current) return;

      // Sammle alle Final-Texts dieser Session, dann Prefix-Dedup:
      // wenn ein späteres final mit einem früheren beginnt, ersetzt es das frühere.
      const rawFinals = [];
      let interim = "";
      for (let i = 0; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) {
          rawFinals.push(r[0].transcript.trim());
        } else {
          interim = r[0].transcript;
        }
      }
      // Prefix-Dedup: behalte nur Finals, die NICHT als Prefix eines späteren Finals vorkommen
      const dedupedFinals = [];
      for (let i = 0; i < rawFinals.length; i++) {
        let supersededByLater = false;
        for (let j = i + 1; j < rawFinals.length; j++) {
          const a = rawFinals[i].toLowerCase();
          const b = rawFinals[j].toLowerCase();
          if (b === a || b.startsWith(a + " ") || b.startsWith(a)) {
            supersededByLater = true;
            break;
          }
        }
        if (!supersededByLater) dedupedFinals.push(rawFinals[i]);
      }
      let allFinals = dedupedFinals.join(" ");

      // Echo-Schutz aus vorheriger Session (nach Restart)
      if (isFirstFinalAfterRestartRef.current && allFinals && lastSessionFinalTextRef.current) {
        const lower = allFinals.toLowerCase();
        const lastLower = lastSessionFinalTextRef.current.toLowerCase();
        if (lower === lastLower) {
          allFinals = "";
        } else if (lower.startsWith(lastLower + " ")) {
          allFinals = allFinals.substring(lastSessionFinalTextRef.current.length).trim();
        } else if (lower.startsWith(lastLower)) {
          allFinals = allFinals.substring(lastSessionFinalTextRef.current.length).trim();
        }
        isFirstFinalAfterRestartRef.current = false;
      } else if (allFinals) {
        isFirstFinalAfterRestartRef.current = false;
      }

      sessionFinalRef.current = allFinals;
      sessionInterimRef.current = interim;

      if (recognitionModeRef.current === "input") {
        const combined = allFinals + (allFinals && interim ? " " : "") + interim;
        setInput(inputBaseRef.current + combined);
      }
      else if (recognitionModeRef.current === "shadowing") {
        const transcript = Array.from(event.results)
          .map((r) => r[0].transcript).join("");
        setShadowing((prev) => prev ? { ...prev, transcript } : prev);
      }
    };
    rec.onend = () => {
      if (recognitionModeRef.current === "shadowing") {
        const s = shadowingRef.current;
        if (s && s.phase === "listening") {
          const { words, score } = compareShadowing(s.original, s.transcript || "");
          setShadowing({ ...s, phase: "done", words, score });
        }
        setRecording(false);
        recognitionModeRef.current = null;
        return;
      }
      if (recognitionModeRef.current === "input" && !userStoppedRef.current) {
        if (sessionFinalRef.current) {
          inputBaseRef.current = inputBaseRef.current + sessionFinalRef.current
            + (sessionFinalRef.current.endsWith(" ") ? "" : " ");
          lastSessionFinalTextRef.current = sessionFinalRef.current;
        }
        sessionFinalRef.current = "";
        sessionInterimRef.current = "";
        isFirstFinalAfterRestartRef.current = true;
        restartCooldownRef.current = Date.now() + 1000;
        setTimeout(() => {
          if (recognitionRef.current && !userStoppedRef.current
              && recognitionModeRef.current === "input") {
            try { recognitionRef.current.start(); } catch {
              setRecording(false);
              recognitionModeRef.current = null;
            }
          }
        }, 300);
        return;
      }
      setRecording(false);
      recognitionModeRef.current = null;
    };
    rec.onerror = () => {
      setRecording(false);
      recognitionModeRef.current = null;
    };
    recognitionRef.current = rec;
  }, [speechSupported]);

  useEffect(() => {
    if (!ttsSupported) return;
    const load = () => window.speechSynthesis.getVoices();
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => { if (ttsSupported) window.speechSynthesis.cancel(); };
  }, [ttsSupported]);

  useEffect(() => {
    if (scrollRef.current && activeTab === "chat") {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streaming, loading, activeTab, shadowing]);

  useEffect(() => {
    if (!autoSpeak || !ttsSupported) return;
    if (streaming || loading) return;
    const lastIdx = messages.length - 1;
    if (lastIdx < 0) return;
    if (messages[lastIdx].role !== "assistant") return;
    if (lastAutoSpokenIdxRef.current >= lastIdx) return;
    lastAutoSpokenIdxRef.current = lastIdx;
    speakInternal(messages[lastIdx].content, `auto-${lastIdx}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, streaming, loading, autoSpeak]);

  const unlockTTS = () => {
    if (!ttsSupported || ttsUnlocked) return;
    try {
      const u = new SpeechSynthesisUtterance("");
      u.volume = 0;
      window.speechSynthesis.speak(u);
      setTtsUnlocked(true);
    } catch {}
  };

  const systemPrompt = useCallback(() => `Du bist ein warmherziger, geduldiger Sprachlehrer für ${language.name} (${language.native}).

WICHTIGSTE REGEL: Antworte AUSSCHLIESSLICH in ${language.native}. Niemals Deutsch oder andere Sprachen.

Niveau: ${level.code} – ${level.name} (${level.desc})
Passe Wortschatz, Satzlänge und Tempo strikt diesem Niveau an.

${topic ? `Bevorzugtes Thema: ${topic}.` : ""}

Verhalten:
- Stelle offene Folgefragen.
- Korrigiere relevante Fehler sanft inline (in Klammern, in der Zielsprache).
- Halte Antworten kurz: 2–4 Sätze. Klar und gut artikulierbar.
- Bei der ersten Nachricht: warme Begrüßung + offene Frage ${topic ? `zum Thema "${topic}"` : ""}.
- Vermeide Anführungszeichen um deine Sätze.`, [language, level, topic]);

  const callClaudeStream = async (msgs, system, onChunk) => {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        stream: true,
        system,
        messages: msgs,
      }),
    });
    if (!response.ok || !response.body) throw new Error("API-Fehler");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload);
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            full += evt.delta.text;
            onChunk(full);
          }
        } catch {}
      }
    }
    return full;
  };

  const callClaude = async (msgs, system) => {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        system,
        messages: msgs,
      }),
    });
    if (!response.ok) throw new Error("API-Fehler");
    const data = await response.json();
    return data.content.map((c) => c.type === "text" ? c.text : "").join("");
  };

  const startConversation = async () => {
    unlockTTS();
    setSetupDone(true);
    setLoading(true);
    setStreaming("");
    try {
      const reply = await callClaudeStream(
        [{ role: "user", content: "Beginne unser Gespräch." }],
        systemPrompt(), (txt) => setStreaming(txt),
      );
      setMessages([{ role: "assistant", content: reply }]);
      setStreaming("");
    } catch {
      setMessages([{ role: "assistant", content: "(Verbindungsfehler)" }]);
      setStreaming("");
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  // Entfernt aufeinanderfolgende identische Wörter (Safety-Net gegen Mic-Echo)
  const dedupConsecutiveWords = (text) => {
    const tokens = text.split(/\s+/).filter(Boolean);
    const result = [];
    for (const token of tokens) {
      const cleanLower = token.replace(/[.,!?;:]+$/, "").toLowerCase();
      const lastCleanLower = result.length > 0
        ? result[result.length - 1].replace(/[.,!?;:]+$/, "").toLowerCase()
        : "";
      if (cleanLower !== lastCleanLower) {
        result.push(token);
      }
    }
    return result.join(" ");
  };

  const sendMessage = async () => {
    if (!input.trim() || loading) return;
    if (recording) { userStoppedRef.current = true; recognitionRef.current?.stop(); }

    let userContent = dedupConsecutiveWords(input.trim());
    let germanOriginal = null;

    // Bei Translate-Modus: erst ins Italienische/Spanische/etc. übersetzen
    if (translateMode) {
      setTranslatingInput(true);
      try {
        const sys = `Du bist ein präziser Übersetzer für Sprachlerner. Übersetze den folgenden deutschen Text ins ${language.native}, natürlich und auf Niveau ${level.code} (${level.name}). Antworte AUSSCHLIESSLICH mit der Übersetzung, ohne Anführungszeichen, ohne Erklärung, ohne Anrede.`;
        const translated = await callClaude(
          [{ role: "user", content: userContent }], sys,
        );
        germanOriginal = userContent;
        userContent = translated.trim();
      } catch {
        setTranslatingInput(false);
        return;
      }
      setTranslatingInput(false);
    }

    const userMsg = { role: "user", content: userContent, germanOriginal };
    const newMsgs = [...messages, userMsg];
    setMessages(newMsgs);
    setInput("");
    setLoading(true);
    setStreaming("");
    try {
      const reply = await callClaudeStream(
        newMsgs.map((m) => ({ role: m.role, content: m.content })),
        systemPrompt(), (txt) => setStreaming(txt),
      );
      setMessages([...newMsgs, { role: "assistant", content: reply }]);
      setStreaming("");
    } catch {
      setMessages([...newMsgs, { role: "assistant", content: "(Verbindungsfehler)" }]);
      setStreaming("");
    } finally {
      setLoading(false);
    }
  };

  // PHRASEN: erstelle eine übersetzte Phrasenkarte (kein Chat)
  const createPhrase = async () => {
    if (!input.trim() || creatingPhrase) return;
    if (recording) { userStoppedRef.current = true; recognitionRef.current?.stop(); }
    const german = dedupConsecutiveWords(input.trim());
    setCreatingPhrase(true);
    setInput("");
    try {
      const sys = `Du bist ein präziser Übersetzer für Sprachlerner. Übersetze den folgenden deutschen Text ins ${language.native}, natürlich und idiomatisch auf Niveau ${level.code} (${level.name}). Wenn es eine typische Alltagsphrase ist, nimm die natürlichste Form, die ein Muttersprachler verwenden würde. Antworte AUSSCHLIESSLICH mit der Übersetzung, ohne Anführungszeichen, ohne Erklärung.`;
      const translated = await callClaude([{ role: "user", content: german }], sys);
      const target = translated.trim();
      const phrase = {
        id: `phrase-${Date.now()}`,
        german,
        target,
        languageCode: language.code,
        languageNative: language.native,
        languageFlag: language.flag,
        levelCode: level.code,
        bcp47: language.bcp47,
      };
      setCurrentPhrase(phrase);
      // Auto-TTS
      if (ttsSupported && autoSpeak) speakInternal(target, "phrase-tts", 0.9);
    } catch {
      setInput(german); // zurücksetzen damit User nochmal versuchen kann
    } finally {
      setCreatingPhrase(false);
    }
  };

  const savePhrase = () => {
    if (!currentPhrase) return;
    // Vermeide Duplikate (gleiches german + target schon vorhanden)
    const exists = phrases.some(p =>
      p.german.toLowerCase() === currentPhrase.german.toLowerCase()
      && p.target.toLowerCase() === currentPhrase.target.toLowerCase()
    );
    if (!exists) {
      setPhrases(prev => [{ ...currentPhrase, savedAt: Date.now() }, ...prev]);
    }
    setCurrentPhrase(null);
  };

  const discardPhrase = () => {
    if (ttsSupported) window.speechSynthesis.cancel();
    setCurrentPhrase(null);
  };

  const removePhrase = (id) => {
    setPhrases(prev => prev.filter(p => p.id !== id));
  };

  const togglePhraseMode = () => {
    const next = !phraseMode;
    setPhraseMode(next);
    if (next) setTranslateMode(true); // Phrase-Mode aktiviert DE→IT automatisch
  };

  const handleSubmit = () => {
    if (phraseMode) createPhrase();
    else sendMessage();
  };

  const translate = async (idx, text) => {
    if (translations[idx]) {
      setTranslations((p) => { const c = { ...p }; delete c[idx]; return c; });
      return;
    }
    setTranslatingIdx(idx);
    try {
      const sys = `Du bist ein präziser Übersetzer. Übersetze aus dem ${language.native} ins Deutsche, natürlich und kompakt. Antworte NUR mit der Übersetzung.`;
      const t = await callClaude([{ role: "user", content: text }], sys);
      setTranslations((p) => ({ ...p, [idx]: t.trim() }));
    } catch {
      setTranslations((p) => ({ ...p, [idx]: "(Übersetzung fehlgeschlagen)" }));
    } finally {
      setTranslatingIdx(null);
    }
  };

  const toggleMic = async () => {
    unlockTTS();
    if (!recognitionRef.current) return;
    if (recording) {
      userStoppedRef.current = true;
      recognitionRef.current.stop();
      return;
    }
    // Permission explizit anfordern
    if (navigator?.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        alert("Mikrofon-Zugriff verweigert. Bitte in den Browser-Einstellungen erlauben.");
        return;
      }
    }
    try {
      if (ttsSupported) window.speechSynthesis.cancel();
      recognitionModeRef.current = "input";
      userStoppedRef.current = false;
      const existing = input.trim();
      inputBaseRef.current = existing ? existing + " " : "";
      sessionFinalRef.current = "";
      sessionInterimRef.current = "";
      restartCooldownRef.current = 0;
      lastSessionFinalTextRef.current = "";
      isFirstFinalAfterRestartRef.current = false;
      recognitionRef.current.continuous = true;
      recognitionRef.current.lang = translateMode ? "de-DE" : language.bcp47;
      recognitionRef.current.start();
      setRecording(true);
    } catch {}
  };

  const speakInternal = (text, id, rate = 0.95) => {
    if (!ttsSupported) return null;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = language.bcp47;
    const voices = window.speechSynthesis.getVoices();
    const match = voices.find((v) => v.lang === language.bcp47)
              || voices.find((v) => v.lang.startsWith(language.code));
    if (match) u.voice = match;
    u.rate = rate;
    u.onend = () => setSpeakingId(null);
    u.onerror = () => setSpeakingId(null);
    setSpeakingId(id);
    window.speechSynthesis.speak(u);
    return u;
  };

  const speak = (text, id) => {
    unlockTTS();
    if (speakingId === id) {
      window.speechSynthesis.cancel();
      setSpeakingId(null);
      return;
    }
    speakInternal(text, id);
  };

  const speakAndWait = (text, rate = 0.9) => new Promise((resolve) => {
    if (!ttsSupported) { resolve(); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = language.bcp47;
    const voices = window.speechSynthesis.getVoices();
    const match = voices.find((v) => v.lang === language.bcp47)
              || voices.find((v) => v.lang.startsWith(language.code));
    if (match) u.voice = match;
    u.rate = rate;
    u.onend = () => { setSpeakingId(null); resolve(); };
    u.onerror = () => { setSpeakingId(null); resolve(); };
    setSpeakingId("shadowing-play");
    window.speechSynthesis.speak(u);
  });

  const startShadowing = async (msgIdx, original) => {
    unlockTTS();
    if (recording) { userStoppedRef.current = true; recognitionRef.current?.stop(); }
    if (ttsSupported) window.speechSynthesis.cancel();
    setShadowing({ msgIdx, original, phase: "playing", transcript: "", words: null, score: null });
    await speakAndWait(original, 0.85);
    await new Promise((r) => setTimeout(r, 300));
    if (shadowingRef.current?.msgIdx !== msgIdx) return;
    setShadowing((prev) => prev ? { ...prev, phase: "listening" } : prev);
    if (recognitionRef.current && speechSupported) {
      try {
        if (navigator?.mediaDevices?.getUserMedia) {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop());
        }
        recognitionModeRef.current = "shadowing";
        recognitionRef.current.continuous = false;  // Shadowing: kurzer Satz, automatisch stoppen
        recognitionRef.current.lang = language.bcp47;
        recognitionRef.current.start();
        setRecording(true);
      } catch {}
    }
  };

  const stopShadowingRecording = () => {
    if (recognitionRef.current && recognitionModeRef.current === "shadowing") {
      recognitionRef.current.stop();
    }
  };

  const retryShadowing = () => {
    if (!shadowing) return;
    startShadowing(shadowing.msgIdx, shadowing.original);
  };

  const playShadowingOriginal = async () => {
    if (!shadowing) return;
    await speakAndWait(shadowing.original, 0.85);
  };

  const closeShadowing = () => {
    if (recognitionRef.current && recognitionModeRef.current === "shadowing") {
      recognitionRef.current.stop();
    }
    if (ttsSupported) window.speechSynthesis.cancel();
    setShadowing(null);
    setSpeakingId(null);
  };

  const handleWordClick = async (word, ctx) => {
    const cleaned = word.replace(/[.,!?;:¿¡()«»""''""…\-—–]/g, "").trim();
    if (!cleaned) return;
    const already = vocab.find((v) => v.word.toLowerCase() === cleaned.toLowerCase());
    setWordPopup({ word: cleaned, ctx, info: null, loading: true, saved: !!already });
    try {
      const sys = `Du bist ein Vokabel-Assistent für ${language.name}.
Gib NUR ein JSON-Objekt zurück mit Feldern:
- "lemma": Grundform (Infinitiv bei Verben, Singular bei Nomen, mit Artikel falls relevant)
- "translation": deutsche Übersetzung (1–3 Worte, kontextpassend)
- "example": kurzer neuer Beispielsatz in ${language.native} (max 12 Wörter)
- "exampleDe": deutsche Übersetzung des Beispielsatzes
- "note": optionale 1-Satz-Anmerkung zu Grammatik/Gebrauch (in Deutsch), oder leer

Antworte AUSSCHLIESSLICH mit dem JSON, ohne Markdown.`;
      const reply = await callClaude(
        [{ role: "user", content: `Wort: "${cleaned}"\nKontext: "${ctx}"` }], sys,
      );
      const parsed = JSON.parse(reply.replace(/```json|```/g, "").trim());
      setWordPopup({ word: cleaned, ctx, info: parsed, loading: false, saved: !!already });
    } catch {
      setWordPopup({ word: cleaned, ctx, info: null, loading: false, error: true, saved: !!already });
    }
  };

  const addToVocab = () => {
    if (!wordPopup?.info || wordPopup.saved) return;
    setVocab((prev) => [
      { word: wordPopup.info.lemma || wordPopup.word, ...wordPopup.info, addedAt: Date.now() },
      ...prev,
    ]);
    setWordPopup((p) => ({ ...p, saved: true }));
  };

  const removeVocab = (idx) => setVocab((prev) => prev.filter((_, i) => i !== idx));

  const renderClickableText = (text) => {
    const parts = text.split(/(\s+)/);
    return parts.map((part, i) => {
      if (/^\s+$/.test(part)) return <span key={i}>{part}</span>;
      const stripped = part.replace(/[.,!?;:¿¡()«»""''""…]/g, "");
      if (!stripped) return <span key={i}>{part}</span>;
      return (
        <span
          key={i}
          onClick={() => handleWordClick(part, text)}
          className="cursor-pointer hover:bg-[#C8612D]/20 active:bg-[#C8612D]/30 rounded px-0.5 transition-colors"
        >{part}</span>
      );
    });
  };

  const resetAll = () => {
    if (ttsSupported) window.speechSynthesis.cancel();
    if (recording) { userStoppedRef.current = true; recognitionRef.current?.stop(); }
    setMessages([]); setTranslations({}); setSetupDone(false);
    setInput(""); setStreaming(""); setActiveTab("chat");
    setShadowing(null); lastAutoSpokenIdxRef.current = -1;
  };

  const statusStyles = {
    correct: "bg-[#2D4A36]/15 text-[#2D4A36] border-b-2 border-[#2D4A36]",
    close:   "bg-[#D4A93C]/25 text-[#8C6F1A] border-b-2 border-[#D4A93C]",
    shifted: "bg-[#7C5A8C]/15 text-[#5A3C6E] border-b-2 border-[#7C5A8C]/60 border-dashed",
    missing: "bg-[#C8612D]/15 text-[#C8612D] border-b-2 border-[#C8612D]/60",
  };

  return (
    <div
      className="min-h-screen w-full flex flex-col"
      style={{
        background: "radial-gradient(ellipse at top, #F5EFE2 0%, #EDE4D0 60%, #E5D9BD 100%)",
        fontFamily: "'Manrope', system-ui, sans-serif",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,700;9..144,900&family=Manrope:wght@400;500;600;700&display=swap');
        .font-display { font-family: 'Fraunces', Georgia, serif; font-optical-sizing: auto; }
        @keyframes pulse-dot { 0%,80%,100%{transform:scale(0.6);opacity:0.5;} 40%{transform:scale(1);opacity:1;} }
        .dot { animation: pulse-dot 1.4s ease-in-out infinite both; }
        .dot:nth-child(2) { animation-delay: 0.16s; }
        .dot:nth-child(3) { animation-delay: 0.32s; }
        @keyframes slide-up { from{transform:translateY(8px);opacity:0;} to{transform:translateY(0);opacity:1;} }
        .slide-up { animation: slide-up 0.35s ease-out both; }
        @keyframes slide-sheet { from{transform:translateY(100%);} to{transform:translateY(0);} }
        .slide-sheet { animation: slide-sheet 0.3s cubic-bezier(0.2,0.9,0.3,1) both; }
        @keyframes pulse-ring { 0%{box-shadow:0 0 0 0 rgba(200,97,45,0.5);} 70%{box-shadow:0 0 0 14px rgba(200,97,45,0);} 100%{box-shadow:0 0 0 0 rgba(200,97,45,0);} }
        .pulse-ring { animation: pulse-ring 1.4s infinite; }
        @keyframes pulse-ring-green { 0%{box-shadow:0 0 0 0 rgba(45,74,54,0.5);} 70%{box-shadow:0 0 0 18px rgba(45,74,54,0);} 100%{box-shadow:0 0 0 0 rgba(45,74,54,0);} }
        .pulse-ring-green { animation: pulse-ring-green 1.4s infinite; }
        .blink-cursor::after { content:'▍';opacity:0.5;animation:blink 1s steps(2) infinite; }
        @keyframes blink { 50%{opacity:0;} }
        @keyframes wave { 0%,100%{transform:scaleY(0.4);} 50%{transform:scaleY(1);} }
        .wave-bar { animation: wave 0.9s ease-in-out infinite; transform-origin: bottom; }
      `}</style>

      {!setupDone ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="w-full max-w-xl slide-up">
            <div className="flex items-center gap-2 mb-2 text-[#2D4A36]">
              <Sparkles size={16} />
              <span className="text-xs uppercase tracking-[0.2em] font-semibold">Sprachen lernen mit Claude</span>
            </div>
            <h1 className="font-display text-5xl sm:text-6xl leading-[0.95] tracking-tight text-[#1F2A20] mb-3">
              <em className="italic font-normal">Sprich</em>,<br />was du lernst.
            </h1>
            <p className="text-[#5C5547] text-base mb-10 max-w-md">
              Hör zu, sprich nach, sammle Vokabeln.
            </p>
            <div className="space-y-7">
              <div>
                <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#2D4A36] mb-3">
                  <Globe2 size={14} /> Sprache
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {LANGUAGES.map((l) => (
                    <button key={l.code} onClick={() => setLanguage(l)}
                      className={`px-3 py-3 rounded-xl text-left transition-all border ${
                        language.code === l.code
                          ? "bg-[#2D4A36] text-[#F5EFE2] border-[#2D4A36] shadow-md"
                          : "bg-[#FBF8F0]/60 border-[#D6CBB0] text-[#1F2A20] hover:border-[#2D4A36]"
                      }`}>
                      <div className="text-xl leading-none mb-1">{l.flag}</div>
                      <div className="font-semibold text-sm">{l.name}</div>
                      <div className="text-[11px] opacity-70">{l.native}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#2D4A36] mb-3">
                  <BookOpen size={14} /> Niveau
                </label>
                <div className="flex flex-wrap gap-2">
                  {LEVELS.map((lv) => (
                    <button key={lv.code} onClick={() => setLevel(lv)}
                      className={`px-4 py-2 rounded-full text-sm transition-all border ${
                        level.code === lv.code
                          ? "bg-[#C8612D] text-[#F5EFE2] border-[#C8612D]"
                          : "bg-[#FBF8F0]/60 border-[#D6CBB0] text-[#1F2A20] hover:border-[#C8612D]"
                      }`}>
                      <span className="font-bold mr-1.5">{lv.code}</span><span>{lv.name}</span>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-[#5C5547] mt-2 italic">{level.desc}</p>
              </div>
              <div>
                <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#2D4A36] mb-3">
                  <Sparkles size={14} /> Thema <span className="opacity-60 normal-case">(optional)</span>
                </label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {TOPICS.map((t) => (
                    <button key={t} onClick={() => setTopic(topic === t ? "" : t)}
                      className={`px-3 py-1.5 rounded-full text-xs transition-all border ${
                        topic === t
                          ? "bg-[#1F2A20] text-[#F5EFE2] border-[#1F2A20]"
                          : "bg-transparent border-[#B8AB8C] text-[#5C5547] hover:border-[#1F2A20]"
                      }`}>{t}</button>
                  ))}
                </div>
                <input type="text" value={topic} onChange={(e) => setTopic(e.target.value)}
                  placeholder="… oder eigenes Thema eingeben"
                  className="w-full px-4 py-2.5 rounded-xl bg-[#FBF8F0]/60 border border-[#D6CBB0] text-sm text-[#1F2A20] placeholder:text-[#9C927A] focus:outline-none focus:border-[#2D4A36]" />
              </div>
              <button onClick={startConversation}
                className="w-full py-4 rounded-2xl bg-[#1F2A20] text-[#F5EFE2] font-display text-lg tracking-tight hover:bg-[#2D4A36] transition-all shadow-lg flex items-center justify-center gap-2">
                Gespräch beginnen <span className="text-xl">{language.flag}</span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col h-screen">
          <header className="px-4 sm:px-5 py-3 border-b border-[#D6CBB0]/60 backdrop-blur-sm bg-[#F5EFE2]/80 flex items-center justify-between sticky top-0 z-10">
            <div className="flex items-center gap-3">
              <span className="text-2xl">{language.flag}</span>
              <div>
                <div className="font-display text-lg leading-tight text-[#1F2A20]">{language.native}</div>
                <div className="text-[11px] text-[#5C5547] uppercase tracking-wider">
                  {level.code} · {topic || "Frei"}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {ttsSupported && (
                <button onClick={() => {
                  unlockTTS();
                  if (autoSpeak) window.speechSynthesis.cancel();
                  setAutoSpeak(!autoSpeak);
                }} className={`p-2 rounded-full transition-all ${
                  autoSpeak ? "bg-[#C8612D] text-[#F5EFE2]" : "text-[#5C5547] hover:bg-[#1F2A20]/10"
                }`}>
                  {autoSpeak ? <Volume2 size={18} /> : <VolumeX size={18} />}
                </button>
              )}
              <button onClick={() => setActiveTab("chat")}
                className={`p-2 rounded-full transition-all ${activeTab === "chat" ? "bg-[#1F2A20] text-[#F5EFE2]" : "text-[#5C5547] hover:bg-[#1F2A20]/10"}`}>
                <MessageSquare size={18} />
              </button>
              <button onClick={() => setActiveTab("vocab")}
                className={`p-2 rounded-full transition-all relative ${activeTab === "vocab" ? "bg-[#1F2A20] text-[#F5EFE2]" : "text-[#5C5547] hover:bg-[#1F2A20]/10"}`}>
                <BookMarked size={18} />
                {vocab.length > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 bg-[#C8612D] text-[#F5EFE2] text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">
                    {vocab.length}
                  </span>
                )}
              </button>
              <button onClick={() => setActiveTab("phrases")}
                className={`p-2 rounded-full transition-all relative ${activeTab === "phrases" ? "bg-[#1F2A20] text-[#F5EFE2]" : "text-[#5C5547] hover:bg-[#1F2A20]/10"}`}>
                <ListMusic size={18} />
                {phrases.filter(p => p.languageCode === language.code).length > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 bg-[#2D4A36] text-[#F5EFE2] text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">
                    {phrases.filter(p => p.languageCode === language.code).length}
                  </span>
                )}
              </button>
              <button onClick={resetAll}
                className="p-2 rounded-full hover:bg-[#1F2A20]/10 transition-colors text-[#5C5547]">
                <RotateCcw size={18} />
              </button>
            </div>
          </header>

          {activeTab === "chat" && (
            <>
              <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 space-y-5">
                {messages.map((m, idx) => (
                  <div key={idx} className={`slide-up flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className="max-w-[88%] sm:max-w-[75%] w-full">
                      {m.role === "assistant" ? (
                        <div>
                          <div className="bg-[#FBF8F0] border border-[#D6CBB0]/80 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
                            <div className="font-display text-[17px] leading-relaxed text-[#1F2A20]">
                              {renderClickableText(m.content)}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 mt-1.5 ml-1 flex-wrap">
                            {ttsSupported && (
                              <button onClick={() => speak(m.content, `msg-${idx}`)}
                                className="inline-flex items-center gap-1 text-[11px] text-[#5C5547] hover:text-[#2D4A36] transition-colors px-2 py-1 rounded-md hover:bg-[#1F2A20]/5">
                                <Volume2 size={11} className={speakingId === `msg-${idx}` ? "animate-pulse text-[#C8612D]" : ""} />
                                {speakingId === `msg-${idx}` ? "Stoppen" : "Anhören"}
                              </button>
                            )}
                            {speechSupported && ttsSupported && (
                              <button onClick={() => startShadowing(idx, m.content)}
                                disabled={shadowing && shadowing.phase !== "done"}
                                className="inline-flex items-center gap-1 text-[11px] text-[#5C5547] hover:text-[#C8612D] transition-colors px-2 py-1 rounded-md hover:bg-[#C8612D]/8 disabled:opacity-40">
                                <Headphones size={11} /> Nachsagen
                              </button>
                            )}
                            <button onClick={() => translate(idx, m.content)}
                              disabled={translatingIdx === idx}
                              className="inline-flex items-center gap-1 text-[11px] text-[#5C5547] hover:text-[#2D4A36] transition-colors disabled:opacity-50 px-2 py-1 rounded-md hover:bg-[#1F2A20]/5">
                              {translatingIdx === idx ? <Loader2 size={11} className="animate-spin" /> : <Languages size={11} />}
                              {translations[idx] ? "Original" : "Auf Deutsch"}
                            </button>
                          </div>
                          {translations[idx] && (
                            <div className="mt-1.5 px-3 py-2 bg-[#2D4A36]/8 border-l-2 border-[#2D4A36]/40 rounded text-[13px] text-[#3A4438] italic slide-up">
                              {translations[idx]}
                            </div>
                          )}
                          {shadowing && shadowing.msgIdx === idx && (
                            <div className="mt-3 p-4 bg-[#FBF8F0] border-2 border-[#C8612D]/40 rounded-2xl shadow-lg slide-up">
                              <div className="flex items-center justify-between mb-3">
                                <div className="flex items-center gap-2">
                                  <Headphones size={14} className="text-[#C8612D]" />
                                  <span className="text-xs uppercase tracking-widest font-semibold text-[#C8612D]">Nachsagen</span>
                                </div>
                                <button onClick={closeShadowing} className="p-1 rounded-full hover:bg-[#1F2A20]/8 text-[#5C5547]">
                                  <X size={14} />
                                </button>
                              </div>
                              {shadowing.phase === "playing" && (
                                <div className="text-center py-4">
                                  <div className="font-display text-[17px] text-[#1F2A20] leading-relaxed mb-4">{shadowing.original}</div>
                                  <div className="flex items-center justify-center gap-1 h-8">
                                    {[0,1,2,3,4].map((i) => (
                                      <div key={i} className="w-1 bg-[#C8612D] rounded-full wave-bar"
                                        style={{ height: "100%", animationDelay: `${i * 0.1}s` }} />
                                    ))}
                                  </div>
                                  <div className="text-xs text-[#5C5547] mt-2 uppercase tracking-wider">Hör genau zu…</div>
                                </div>
                              )}
                              {shadowing.phase === "listening" && (
                                <div className="py-2">
                                  <div className="font-display text-[16px] text-[#5C5547] leading-relaxed mb-4 italic">{shadowing.original}</div>
                                  <div className="flex flex-col items-center gap-3 py-3">
                                    <button onClick={stopShadowingRecording}
                                      className="p-4 rounded-full bg-[#2D4A36] text-[#F5EFE2] shadow-lg pulse-ring-green">
                                      <Mic size={22} />
                                    </button>
                                    <div className="text-xs text-[#5C5547] uppercase tracking-wider">
                                      Sprich nach · tippe um zu beenden
                                    </div>
                                  </div>
                                  {shadowing.transcript && (
                                    <div className="mt-2 px-3 py-2 bg-[#2D4A36]/5 rounded-lg text-sm text-[#3A4438] italic text-center">
                                      „{shadowing.transcript}"
                                    </div>
                                  )}
                                </div>
                              )}
                              {shadowing.phase === "done" && (
                                <div>
                                  <div className="flex items-center justify-between mb-3">
                                    <div className="flex items-center gap-2">
                                      <Award size={18} className={
                                        shadowing.score >= 80 ? "text-[#2D4A36]" :
                                        shadowing.score >= 50 ? "text-[#D4A93C]" : "text-[#C8612D]"
                                      } />
                                      <span className="font-display text-2xl font-bold text-[#1F2A20]">
                                        {shadowing.score}<span className="text-base font-normal opacity-60">%</span>
                                      </span>
                                    </div>
                                    <div className="text-[11px] text-[#5C5547] italic">
                                      {shadowing.score >= 90 ? "Exzellent!" :
                                       shadowing.score >= 75 ? "Sehr gut" :
                                       shadowing.score >= 55 ? "Solide" :
                                       shadowing.score >= 30 ? "Übung macht den Meister" : "Nochmal versuchen?"}
                                    </div>
                                  </div>
                                  <div className="font-display text-[17px] leading-loose text-[#1F2A20] mb-3">
                                    {shadowing.words?.map((w, i) => (
                                      <span key={i} className={`inline-block mx-0.5 px-1 rounded ${statusStyles[w.status]}`}>
                                        {w.word}
                                      </span>
                                    ))}
                                  </div>
                                  {shadowing.transcript && (
                                    <div className="text-[12px] text-[#5C5547] italic mb-3 px-2 py-1.5 bg-[#5C5547]/5 rounded">
                                      Dein Versuch: „{shadowing.transcript}"
                                    </div>
                                  )}
                                  <div className="flex gap-2 text-[11px] text-[#5C5547] flex-wrap mb-3">
                                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#2D4A36]"></span>Korrekt</span>
                                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#D4A93C]"></span>Knapp daneben</span>
                                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#7C5A8C]"></span>Verschoben</span>
                                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#C8612D]"></span>Fehlt</span>
                                  </div>
                                  <div className="flex gap-2">
                                    <button onClick={playShadowingOriginal}
                                      className="flex-1 py-2 px-3 rounded-xl bg-[#FBF8F0] border border-[#D6CBB0] text-[#1F2A20] text-sm font-semibold hover:border-[#2D4A36] transition-colors flex items-center justify-center gap-1.5">
                                      <Volume2 size={14} /> Original
                                    </button>
                                    <button onClick={retryShadowing}
                                      className="flex-1 py-2 px-3 rounded-xl bg-[#C8612D] text-[#F5EFE2] text-sm font-semibold hover:bg-[#A84F22] transition-colors flex items-center justify-center gap-1.5">
                                      <RefreshCw size={14} /> Nochmal
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="ml-auto inline-block max-w-full">
                          <div className="bg-[#1F2A20] text-[#F5EFE2] rounded-2xl rounded-tr-sm px-4 py-3 shadow-sm">
                            <div className="text-[15px] leading-relaxed whitespace-pre-wrap">{m.content}</div>
                          </div>
                          {m.germanOriginal && (
                            <div className="mt-1 mr-1 text-right text-[12px] text-[#5C5547] italic">
                              <span className="opacity-60">🇩🇪 </span>{m.germanOriginal}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {streaming && (
                  <div className="slide-up flex justify-start">
                    <div className="max-w-[88%] sm:max-w-[75%]">
                      <div className="bg-[#FBF8F0] border border-[#D6CBB0]/80 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
                        <div className="font-display text-[17px] leading-relaxed text-[#1F2A20] blink-cursor">{streaming}</div>
                      </div>
                    </div>
                  </div>
                )}
                {loading && !streaming && (
                  <div className="flex justify-start slide-up">
                    <div className="bg-[#FBF8F0] border border-[#D6CBB0]/80 rounded-2xl rounded-tl-sm px-5 py-4 shadow-sm">
                      <div className="flex gap-1.5 items-center">
                        <span className="dot w-2 h-2 bg-[#2D4A36] rounded-full"></span>
                        <span className="dot w-2 h-2 bg-[#2D4A36] rounded-full"></span>
                        <span className="dot w-2 h-2 bg-[#2D4A36] rounded-full"></span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t border-[#D6CBB0]/60 bg-[#F5EFE2]/80 backdrop-blur-sm px-3 sm:px-6 py-3 sm:py-4">
                <div className="flex gap-2 items-end max-w-3xl mx-auto">
                  {speechSupported && (
                    <button onClick={toggleMic}
                      disabled={loading || creatingPhrase || (shadowing && shadowing.phase !== "done")}
                      className={`p-3 rounded-2xl shadow-md transition-all flex-shrink-0 ${
                        recording && recognitionModeRef.current === "input"
                          ? "bg-[#C8612D] text-[#F5EFE2] pulse-ring"
                          : "bg-[#FBF8F0] border border-[#D6CBB0] text-[#1F2A20] hover:border-[#C8612D]"
                      } disabled:opacity-40`}
                      title={translateMode ? "Auf Deutsch sprechen — wird übersetzt" : "Auf Zielsprache sprechen"}>
                      <Mic size={18} />
                    </button>
                  )}
                  <button onClick={() => setTranslateMode(!translateMode)}
                    disabled={loading || translatingInput || creatingPhrase || phraseMode}
                    className={`p-3 rounded-2xl shadow-md transition-all flex-shrink-0 ${
                      translateMode
                        ? "bg-[#2D4A36] text-[#F5EFE2]"
                        : "bg-[#FBF8F0] border border-[#D6CBB0] text-[#1F2A20] hover:border-[#2D4A36]"
                    } disabled:opacity-40`}
                    title={translateMode ? `Deutsch → ${language.native} an` : "Deutsch tippen/sprechen, automatisch übersetzen"}>
                    <span className="text-[11px] font-bold tracking-wider">DE→{language.code.toUpperCase()}</span>
                  </button>
                  <button onClick={togglePhraseMode}
                    disabled={loading || translatingInput || creatingPhrase}
                    className={`p-3 rounded-2xl shadow-md transition-all flex-shrink-0 ${
                      phraseMode
                        ? "bg-[#C8612D] text-[#F5EFE2]"
                        : "bg-[#FBF8F0] border border-[#D6CBB0] text-[#1F2A20] hover:border-[#C8612D]"
                    } disabled:opacity-40`}
                    title={phraseMode ? "Phrasen-Modus aktiv" : "Phrase üben & sammeln statt chatten"}>
                    <Sparkles size={18} />
                  </button>
                  <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
                    rows={1}
                    placeholder={
                      creatingPhrase
                        ? "Übersetze Phrase…"
                        : translatingInput
                        ? "Übersetze…"
                        : recording && recognitionModeRef.current === "input"
                        ? translateMode ? "Hört zu (Deutsch)…" : `Hört zu (${language.native})…`
                        : phraseMode
                        ? "Phrase auf Deutsch — wird übersetzt & vorgelesen"
                        : translateMode
                        ? "Auf Deutsch tippen oder sprechen — wird übersetzt"
                        : `Schreibe oder sprich auf ${language.native}…`
                    }
                    className="flex-1 resize-none px-4 py-3 rounded-2xl bg-[#FBF8F0] border border-[#D6CBB0] text-[15px] text-[#1F2A20] placeholder:text-[#9C927A] focus:outline-none focus:border-[#2D4A36] max-h-32"
                    style={{ fontFamily: (translateMode || phraseMode) ? "'Manrope', system-ui, sans-serif" : "'Fraunces', Georgia, serif" }} />
                  <button onClick={handleSubmit} disabled={!input.trim() || loading || translatingInput || creatingPhrase}
                    className="p-3 rounded-2xl bg-[#1F2A20] text-[#F5EFE2] hover:bg-[#2D4A36] disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-md flex-shrink-0">
                    {translatingInput || creatingPhrase ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                  </button>
                </div>
                <div className="text-[10px] text-center text-[#9C927A] mt-2 uppercase tracking-wider">
                  {recording && recognitionModeRef.current === "input"
                    ? "🔴 Aufnahme läuft · tippe Mic erneut zum Senden"
                    : phraseMode
                    ? `✨ Phrasen-Modus · 🇩🇪 → ${language.flag} ${language.native}`
                    : translateMode
                    ? `🇩🇪 → ${language.flag} Deutsch wird übersetzt`
                    : autoSpeak
                    ? "🔊 Auto-Vorlesen aktiv"
                    : "Tippe auf ein Wort um es zu sammeln"}
                </div>
              </div>
            </>
          )}

          {activeTab === "vocab" && (
            <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
              {vocab.length === 0 ? (
                <div className="max-w-md mx-auto text-center py-16 slide-up">
                  <BookMarked size={36} className="mx-auto text-[#5C5547]/40 mb-4" />
                  <div className="font-display text-2xl text-[#1F2A20] mb-2">Noch leer.</div>
                  <p className="text-sm text-[#5C5547]">Tippe in der Konversation auf ein Wort.</p>
                </div>
              ) : (
                <div className="max-w-2xl mx-auto space-y-3">
                  <div className="text-xs uppercase tracking-wider text-[#5C5547] font-semibold mb-2">
                    {vocab.length} Vokabeln · {language.native}
                  </div>
                  {vocab.map((v, i) => (
                    <div key={i} className="bg-[#FBF8F0] border border-[#D6CBB0]/80 rounded-2xl p-4 shadow-sm slide-up">
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-display text-2xl text-[#1F2A20]">{v.word}</span>
                            {ttsSupported && (
                              <button onClick={() => speak(v.word, `vocab-${i}`)}
                                className="p-1.5 rounded-full hover:bg-[#1F2A20]/8 text-[#5C5547]">
                                <Volume2 size={14} className={speakingId === `vocab-${i}` ? "animate-pulse text-[#C8612D]" : ""} />
                              </button>
                            )}
                          </div>
                          <div className="text-base text-[#2D4A36] font-medium">{v.translation}</div>
                        </div>
                        <button onClick={() => removeVocab(i)}
                          className="p-1.5 rounded-full text-[#9C927A] hover:text-[#C8612D] hover:bg-[#C8612D]/10">
                          <Trash2 size={14} />
                        </button>
                      </div>
                      {v.example && (
                        <div className="mt-2 pl-3 border-l-2 border-[#D6CBB0]">
                          <div className="font-display italic text-[15px] text-[#1F2A20] flex items-start gap-2">
                            <span className="flex-1">{v.example}</span>
                            {ttsSupported && (
                              <button onClick={() => speak(v.example, `ex-${i}`)}
                                className="p-1 rounded-full hover:bg-[#1F2A20]/8 text-[#5C5547] flex-shrink-0">
                                <Volume2 size={12} className={speakingId === `ex-${i}` ? "animate-pulse text-[#C8612D]" : ""} />
                              </button>
                            )}
                          </div>
                          <div className="text-[13px] text-[#5C5547] italic mt-0.5">{v.exampleDe}</div>
                        </div>
                      )}
                      {v.note && <div className="text-[12px] text-[#5C5547] mt-2 italic">💡 {v.note}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === "phrases" && (
            <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
              {phrases.filter(p => p.languageCode === language.code).length === 0 ? (
                <div className="max-w-md mx-auto text-center py-16 slide-up">
                  <ListMusic size={36} className="mx-auto text-[#5C5547]/40 mb-4" />
                  <div className="font-display text-2xl text-[#1F2A20] mb-2">Noch keine Phrasen.</div>
                  <p className="text-sm text-[#5C5547]">
                    Aktiviere den ✨ Phrasen-Modus unten und sprich auf Deutsch — z.&nbsp;B. <em>„Ich hätte gerne eine Pizza"</em>.
                  </p>
                </div>
              ) : (
                <div className="max-w-2xl mx-auto space-y-3">
                  <div className="text-xs uppercase tracking-wider text-[#5C5547] font-semibold mb-2">
                    {phrases.filter(p => p.languageCode === language.code).length} Phrasen · {language.native}
                  </div>
                  {phrases.filter(p => p.languageCode === language.code).map((p) => (
                    <div key={p.id} className="bg-[#FBF8F0] border border-[#D6CBB0]/80 rounded-2xl p-4 shadow-sm slide-up">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="text-[12px] text-[#5C5547] italic mb-1">
                            <span className="opacity-60">🇩🇪 </span>{p.german}
                          </div>
                          <div className="flex items-start gap-2">
                            <div className="font-display text-xl text-[#1F2A20] leading-tight flex-1">{p.target}</div>
                          </div>
                          <div className="flex items-center gap-2 mt-3">
                            {ttsSupported && (
                              <button onClick={() => speak(p.target, `phrase-list-${p.id}`)}
                                className="flex items-center gap-1 text-[12px] text-[#5C5547] hover:text-[#2D4A36] uppercase tracking-wider">
                                <Volume2 size={14} className={speakingId === `phrase-list-${p.id}` ? "animate-pulse text-[#C8612D]" : ""} />
                                <span>Anhören</span>
                              </button>
                            )}
                          </div>
                        </div>
                        <button onClick={() => removePhrase(p.id)}
                          className="p-1.5 rounded-full text-[#9C927A] hover:text-[#C8612D] hover:bg-[#C8612D]/10 flex-shrink-0">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {currentPhrase && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => discardPhrase()}>
          <div className="bg-[#FBF8F0] w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl p-6 slide-sheet shadow-2xl border border-[#D6CBB0]/60"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-2">
                <Sparkles size={16} className="text-[#C8612D]" />
                <span className="text-[10px] uppercase tracking-widest text-[#5C5547] font-semibold">Neue Phrase</span>
              </div>
              <button onClick={discardPhrase}
                className="p-1.5 rounded-full hover:bg-[#1F2A20]/8 text-[#5C5547]">
                <X size={18} />
              </button>
            </div>
            <div className="text-[13px] text-[#5C5547] italic mb-2">
              <span className="opacity-60">🇩🇪 </span>{currentPhrase.german}
            </div>
            <div className="font-display text-2xl sm:text-3xl text-[#1F2A20] leading-tight mb-5">
              {currentPhrase.target}
            </div>
            <div className="flex flex-wrap gap-2">
              {ttsSupported && (
                <button onClick={() => speak(currentPhrase.target, "phrase-card-tts")}
                  className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-[#FBF8F0] border border-[#D6CBB0] text-[#1F2A20] hover:border-[#2D4A36] text-sm">
                  <Volume2 size={16} className={speakingId === "phrase-card-tts" ? "animate-pulse text-[#C8612D]" : ""} />
                  <span>Nochmal anhören</span>
                </button>
              )}
              <button onClick={discardPhrase}
                className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-[#FBF8F0] border border-[#D6CBB0] text-[#5C5547] hover:border-[#C8612D] hover:text-[#C8612D] text-sm">
                <Trash2 size={16} />
                <span>Verwerfen</span>
              </button>
              <button onClick={savePhrase}
                className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-[#2D4A36] text-[#F5EFE2] hover:bg-[#1F2A20] text-sm ml-auto">
                <Save size={16} />
                <span>Sammeln</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {wordPopup && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => { if (ttsSupported) window.speechSynthesis.cancel(); setWordPopup(null); setSpeakingId(null); }}>
          <div className="bg-[#FBF8F0] w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl p-6 slide-sheet shadow-2xl border border-[#D6CBB0]/60"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-[#5C5547] mb-1">{language.native}</div>
                <div className="font-display text-4xl text-[#1F2A20] flex items-center gap-2 leading-tight">
                  {wordPopup.word}
                  {ttsSupported && (
                    <button onClick={() => speak(wordPopup.info?.lemma || wordPopup.word, "popup-word")}
                      className="p-1.5 rounded-full hover:bg-[#1F2A20]/8 text-[#2D4A36]">
                      <Volume2 size={18} className={speakingId === "popup-word" ? "animate-pulse text-[#C8612D]" : ""} />
                    </button>
                  )}
                </div>
              </div>
              <button onClick={() => { if (ttsSupported) window.speechSynthesis.cancel(); setWordPopup(null); setSpeakingId(null); }}
                className="p-1.5 rounded-full hover:bg-[#1F2A20]/8 text-[#5C5547]">
                <X size={18} />
              </button>
            </div>
            {wordPopup.loading && (
              <div className="py-8 flex items-center justify-center">
                <Loader2 size={20} className="animate-spin text-[#2D4A36]" />
              </div>
            )}
            {wordPopup.error && (
              <div className="py-4 text-sm text-[#C8612D]">Konnte das Wort nicht analysieren.</div>
            )}
            {wordPopup.info && (
              <div className="space-y-4">
                {wordPopup.info.lemma && wordPopup.info.lemma.toLowerCase() !== wordPopup.word.toLowerCase() && (
                  <div className="text-sm text-[#5C5547]">
                    Grundform: <span className="font-semibold text-[#1F2A20] font-display text-base">{wordPopup.info.lemma}</span>
                  </div>
                )}
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-[#5C5547] mb-1">Deutsch</div>
                  <div className="text-xl text-[#2D4A36] font-semibold">{wordPopup.info.translation}</div>
                </div>
                {wordPopup.info.example && (
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-[#5C5547] mb-1">Beispiel</div>
                    <div className="font-display italic text-[17px] text-[#1F2A20] flex items-start gap-2">
                      <span className="flex-1">{wordPopup.info.example}</span>
                      {ttsSupported && (
                        <button onClick={() => speak(wordPopup.info.example, "popup-ex")}
                          className="p-1 rounded-full hover:bg-[#1F2A20]/8 text-[#5C5547] flex-shrink-0">
                          <Volume2 size={14} className={speakingId === "popup-ex" ? "animate-pulse text-[#C8612D]" : ""} />
                        </button>
                      )}
                    </div>
                    <div className="text-sm text-[#5C5547] italic mt-1">{wordPopup.info.exampleDe}</div>
                  </div>
                )}
                {wordPopup.info.note && (
                  <div className="text-sm text-[#5C5547] bg-[#2D4A36]/5 border-l-2 border-[#2D4A36]/30 px-3 py-2 rounded">
                    💡 {wordPopup.info.note}
                  </div>
                )}
                <button onClick={addToVocab} disabled={wordPopup.saved}
                  className={`w-full mt-2 py-3 rounded-2xl font-semibold text-sm transition-all flex items-center justify-center gap-2 ${
                    wordPopup.saved
                      ? "bg-[#2D4A36]/15 text-[#2D4A36] cursor-default"
                      : "bg-[#1F2A20] text-[#F5EFE2] hover:bg-[#2D4A36] shadow"
                  }`}>
                  {wordPopup.saved ? (<><Check size={16} /> Im Vokabelheft</>) : (<><Plus size={16} /> Zum Vokabelheft</>)}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
