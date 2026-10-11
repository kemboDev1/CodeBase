/**
 * Language detection + greeting handling. A small local model drifts to Spanish or
 * Russian when it is unsure; we detect the user's language and lock the answer to it.
 */

export function detectLanguage(input) {
  const value = String(input || '').trim();
  const lower = value.toLocaleLowerCase();
  if (/[\u4e00-\u9fff]/u.test(value)) return { code: 'zh', name: 'Chinese (Simplified)' };
  if (/[\u3040-\u30ff]/u.test(value)) return { code: 'ja', name: 'Japanese' };
  if (/[\uac00-\ud7af]/u.test(value)) return { code: 'ko', name: 'Korean' };
  if (/[\u0600-\u06ff]/u.test(value)) return { code: 'ar', name: 'Arabic' };
  if (/[\u0900-\u097f]/u.test(value)) return { code: 'hi', name: 'Hindi' };
  if (/[\u0400-\u04ff]/u.test(value)) return { code: 'ru', name: 'Russian' };
  const has = (words) => new RegExp(`(?:^|[^\\p{L}])(?:${words})(?=$|[^\\p{L}])`, 'iu').test(lower);
  if (/[¿¡ñáéíóú]/iu.test(value) || has('hola|gracias|ayuda|puedes|quiero|necesito|cómo|estás|qué|por favor|buenos días')) return { code: 'es', name: 'Spanish' };
  if (has('merhaba|teşekkür|nasılsın|lütfen|istiyorum|bana|neden|nasıl|yapabilir')) return { code: 'tr', name: 'Turkish' };
  if (has('bonjour|merci|comment|pourquoi|aidez|salut|développer')) return { code: 'fr', name: 'French' };
  if (has('hallo|danke|bitte|warum|wie|ich|nicht|möchte')) return { code: 'de', name: 'German' };
  if (has('salom|assalomu|alaykum|menga|men|sen|siz|qanday|qaysi|nima|qil|qilib|kerak|uchun|bilan|endi|ber|yoz|tuzat|ishlay|bo‘ladi|bo\'ladi|emas|rahmat|kompyuter|loyiha|o‘zbek|o\'zbek|til|qilyapman|qilmoqchi|fayl|kod|ishga|tushir')) return { code: 'uz', name: 'Uzbek (Latin script)' };
  if (has('hello|hi|hey|please|what|why|how|can you|could you|help|thanks|thank you|write|build|fix|explain|make|create|the|and|with|for|from|is|are|my|your')) return { code: 'en', name: 'English' };
  return { code: 'uz', name: 'Uzbek (Latin script)' };
}

const GREETINGS = new Set([
  'salom', 'assalomu alaykum', 'assalomu alaykum va rahmatullohi va barokatuh', 'qalaysan', 'yaxshimisan',
  'hello', 'hi', 'hey', 'hola', 'buenos días', 'buenas', 'привет', 'здравствуйте',
  'merhaba', 'bonjour', 'salut', 'hallo', '你好', 'こんにちは', '안녕하세요', 'مرحبا', 'नमस्ते'
]);

/** Instant local reply for a pure greeting — no model round trip, no Ollama needed. */
export function greetingReply(input, language) {
  const normalized = String(input || '').toLocaleLowerCase().normalize('NFKC').replace(/[.!?,¡¿]+/g, '').trim();
  if (!GREETINGS.has(normalized)) return null;
  const replies = {
    uz: 'Salom! Men CodeBase — kompyuteringizda ishlaydigan AI kodlash agentiman. Fayllaringizni o‘qiy olaman, kod yozaman, terminal buyruqlarini bajaraman, MCP serverlar va skillardan foydalanaman. Nima ustida ishlaymiz?',
    en: 'Hello! I am CodeBase, your local AI coding agent. I can read your files, write code, run terminal commands, and use MCP servers and skills. What are we building?',
    es: '¡Hola! Soy CodeBase, tu agente local de programación. Puedo leer archivos, escribir código, ejecutar comandos y usar servidores MCP. ¿Qué construimos?',
    ru: 'Здравствуйте! Я CodeBase — локальный ИИ-агент для программирования. Могу читать файлы, писать код, запускать команды, использовать MCP-серверы и навыки. Над чем работаем?',
    tr: 'Merhaba! Ben CodeBase, yerel yapay zekâ kodlama ajanınızım. Dosyaları okuyabilir, kod yazabilir, komut çalıştırabilirim. Ne üzerinde çalışıyoruz?',
    fr: 'Bonjour ! Je suis CodeBase, votre agent de programmation local. Je peux lire des fichiers, écrire du code et exécuter des commandes. Que construisons-nous ?',
    de: 'Hallo! Ich bin CodeBase, dein lokaler KI-Coding-Agent. Ich kann Dateien lesen, Code schreiben und Befehle ausführen. Was bauen wir?',
    zh: '你好！我是 CodeBase，你的本地 AI 编程代理。我可以读取文件、编写代码并执行命令。我们要做什么？',
    ja: 'こんにちは！CodeBaseです。ローカルで動くAIコーディングエージェントです。ファイルの読み書きやコマンド実行ができます。何を作りましょうか？',
    ko: '안녕하세요! 저는 로컬 AI 코딩 에이전트 CodeBase입니다. 파일을 읽고 코드를 작성하고 명령을 실행할 수 있습니다. 무엇을 만들까요?',
    ar: 'مرحبًا! أنا CodeBase، وكيل البرمجة المحلي. يمكنني قراءة الملفات وكتابة الكود وتنفيذ الأوامر. ماذا سنبني؟',
    hi: 'नमस्ते! मैं CodeBase हूँ, आपका स्थानीय AI कोडिंग एजेंट। मैं फ़ाइलें पढ़ सकता हूँ, कोड लिख सकता हूँ और कमांड चला सकता हूँ। हम क्या बनाएँ?'
  };
  return replies[language?.code] || replies.uz;
}

const SPANISH_DRIFT = /¡hola|¿cómo estás|en qué puedo ayudarte|soy codebase|puedo ayudarte|¿qué necesitas|con gusto|aquí tienes|por supuesto|para ayudarte|claro que sí/iu;

/** Detect the known Spanish drift of small models so the caller can retry once. */
export function looksLikeSpanishAnswer(answer) {
  return SPANISH_DRIFT.test(String(answer || ''));
}

/** True when the prompt is only a greeting or a very short acknowledgement. */
export function isTrivialPrompt(input) {
  const normalized = String(input || '').toLocaleLowerCase().normalize('NFKC').replace(/[.!?,¡¿]+/g, '').trim();
  return GREETINGS.has(normalized) || /^(ok|okay|rahmat|thanks|thank you|спасибо|gracias|thanks!)$/.test(normalized);
}
