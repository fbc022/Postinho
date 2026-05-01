/**
 * Postinho - Webhook handler para o bot do Telegram
 * v3 - Corrigido: callbacks antigos não causam mais loop de "sessão expirada"
 *      Callbacks sempre processam o dado que veio neles, independente do estado da sessão
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const SPREADSHEET_ID = "1pG_adGrPAxwr-IYfzpZ-UyWT46dcAyzsvaOmmtHziF8";

let GRUPO_ENTREGAS_ID: number | null = null;

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}
interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: TelegramChat;
  text?: string;
  photo?: TelegramPhotoSize[];
}
interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message: TelegramMessage;
  data: string;
}
interface TelegramUser { id: number; first_name: string; username?: string; }
interface TelegramChat { id: number; type: string; title?: string; }
interface TelegramPhotoSize { file_id: string; width: number; height: number; }

// ---- SESSÕES ----
const sessions: Record<number, Record<string, unknown>> = {};
function getSession(userId: number): Record<string, unknown> {
  if (!sessions[userId]) sessions[userId] = { estado: "inicio" };
  return sessions[userId];
}
function resetSession(userId: number): void {
  sessions[userId] = { estado: "inicio" };
}

const CAMINHOES = ["Caminhão Amarelo", "Caminhão Azul", "Caminhão Branco", "Caminhão Poli"];
const FUNCIONARIOS = ["Felipe", "Kauan", "Vitor", "Paulo", "Mauricio", "Antonio", "Flávio", "Fabricio"];

// ---- TELEGRAM API ----
async function tg(method: string, body: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
}
async function sendMessage(chatId: number, text: string, replyMarkup?: unknown) {
  const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "Markdown" };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return tg("sendMessage", body);
}
async function editMessage(chatId: number, messageId: number, text: string, replyMarkup?: unknown) {
  const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown" };
  body.reply_markup = replyMarkup || { inline_keyboard: [] };
  return tg("editMessageText", body);
}
async function answerCallback(callbackId: string, text?: string) {
  return tg("answerCallbackQuery", { callback_query_id: callbackId, text: text || "" });
}
async function sendPhoto(chatId: number, photoFileId: string) {
  return tg("sendPhoto", { chat_id: chatId, photo: photoFileId });
}
function kb(buttons: Array<Array<{ text: string; callback_data: string }>>) {
  return { inline_keyboard: buttons };
}

// ---- GOOGLE SHEETS ----
async function getSheetsToken(base44: ReturnType<typeof createClientFromRequest>): Promise<string> {
  try {
    const { accessToken } = await base44.asServiceRole.connectors.getConnection("googlesheets");
    return accessToken;
  } catch (e) {
    console.error("Erro ao obter token Sheets:", e);
    return "";
  }
}
async function ensureSheetTab(token: string, tabName: string, isPoli: boolean) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}`, { headers });
  const data = await r.json();
  const sheets = (data.sheets || []).map((s: { properties: { title: string } }) => s.properties.title);
  if (!sheets.includes(tabName)) {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`, {
      method: "POST", headers,
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] })
    });
    const headerRow = isPoli
      ? [["Data", "Hora", "Funcionário", "Pedido", "Tipo", "Nº Caçamba", "Nº Caçamba Nova", "Foto"]]
      : [["Data", "Hora", "Caminhão", "Funcionários", "Pedido", "Poste Entregue", "Prumo/Normas", "Fiação", "Quem ficou c/ material", "Tampas OK", "Assinatura", "Motivo Não Entrega", "Fotos"]];
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(tabName)}!A1?valueInputOption=RAW`,
      { method: "PUT", headers, body: JSON.stringify({ values: headerRow }) }
    );
  }
}
async function appendToSheet(token: string, tabName: string, rowData: string[], isPoli = false) {
  if (!token) return;
  await ensureSheetTab(token, tabName, isPoli);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(tabName)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: "POST", headers, body: JSON.stringify({ values: [rowData] }) }
  );
}
async function getPedidosPoli(token: string): Promise<Record<string, string>> {
  if (!token) return {};
  try {
    const r = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent("Caminhão Poli")}!A:F`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) return {};
    const data = await r.json();
    const values: string[][] = data.values || [];
    const pedidos: Record<string, string> = {};
    for (const row of values.slice(1)) {
      if (row.length >= 6 && row[4] && row[5]?.toLowerCase() === "instalação") pedidos[row[4]] = "instalação";
    }
    return pedidos;
  } catch { return {}; }
}

// ---- GRUPO ----
async function enviarResumoGrupo(session: Record<string, unknown>) {
  if (!GRUPO_ENTREGAS_ID) return;
  const caminhao = (session.caminhao as string) || "";
  const now = new Date();
  const dataHora = now.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  let texto = "";
  if (caminhao === "Caminhão Poli") {
    const nova = (session.num_cacamba_nova as string) || "";
    texto = `🚛 *Caminhão Poli - Resumo de Serviço*\n\n👤 Funcionário: ${session.funcionario || ""}\n📦 Pedido: ${session.pedido || ""}\n🔧 Tipo: ${session.tipo_servico || ""}\n🗑️ Nº Caçamba: ${session.num_cacamba || ""}\n`;
    if (nova) texto += `🆕 Nº Nova Caçamba: ${nova}\n`;
  } else {
    const funcs = (session.funcionarios as string[]) || [];
    const entregue = (session.poste_entregue as string) || "";
    texto = `🚛 *${caminhao} - Resumo de Entrega*\n\n👥 Funcionários: ${funcs.join(", ")}\n📦 Pedido: ${session.pedido || ""}\n✅ Poste entregue: ${entregue}\n`;
    if (entregue === "Sim") {
      texto += `📐 Prumo/Normas: ${session.prumo || ""}\n⚡ Fiação: ${session.fiacao || ""}\n`;
      if (session.quem_material) texto += `👤 Material com: ${session.quem_material}\n`;
      texto += `🔒 Tampas OK: ${session.tampas || ""}\n✍️ Assinatura: ${session.assinatura || ""}\n`;
    } else {
      texto += `❌ Motivo: ${session.motivo_nao_entrega || ""}\n`;
    }
  }
  texto += `\n🕐 ${dataHora}`;
  await sendMessage(GRUPO_ENTREGAS_ID, texto);
  for (const fid of ((session.fotos as string[]) || [])) await sendPhoto(GRUPO_ENTREGAS_ID, fid);
}

// =====================
// ---- CALLBACKS ----
// =====================

/**
 * CHAVE DO FIX v3:
 * Callbacks de caminhão e funcionário SEMPRE processam o dado do callback,
 * mesmo que a sessão tenha sido resetada. Nunca mostram "sessão expirada" -
 * em vez disso, reconstroem o estado a partir dos dados disponíveis.
 */

async function handleCallbackCaminhao(userId: number, chatId: number, msgId: number, callbackId: string, data: string) {
  await answerCallback(callbackId);
  const caminhao = data.replace("caminhao_", "");
  // Sempre reseta e redefine a partir deste callback - ignora estado anterior
  resetSession(userId);
  const session = getSession(userId);
  session.caminhao = caminhao;
  session.estado = "escolher_func1";
  const label = caminhao === "Caminhão Poli" ? "Qual funcionário está no caminhão?" : "Quem é o *1º funcionário*?";
  await editMessage(chatId, msgId,
    `🚛 *${caminhao}* selecionado!\n\n${label}`,
    kb(FUNCIONARIOS.map(f => [{ text: f, callback_data: `func1_${f}` }]))
  );
}

async function handleCallbackFunc1(userId: number, chatId: number, msgId: number, callbackId: string, data: string) {
  await answerCallback(callbackId);
  const func1 = data.replace("func1_", "");
  const session = getSession(userId);

  // Se caminhão não está na sessão (callback antigo), pede para reiniciar
  // mas de forma silenciosa - apenas mostra botões de caminhão novamente
  if (!session.caminhao) {
    session.estado = "escolher_caminhao";
    await editMessage(chatId, msgId,
      `🚛 Qual caminhão você está operando hoje?`,
      kb(CAMINHOES.map(c => [{ text: c, callback_data: `caminhao_${c}` }]))
    );
    return;
  }

  session.func1 = func1;
  if (session.caminhao === "Caminhão Poli") {
    session.funcionario = func1;
    session.funcionarios = [func1];
    session.estado = "aguardar_pedido";
    await editMessage(chatId, msgId,
      `👤 *${func1}* confirmado!\n\n✅ *Configuração concluída!*\n\n🚛 Caminhão Poli\n👤 ${func1}\n\nEnvie o *número do pedido* para registrar um serviço.`
    );
  } else {
    session.estado = "escolher_func2";
    const outros = FUNCIONARIOS.filter(f => f !== func1);
    await editMessage(chatId, msgId,
      `👤 *${func1}* confirmado!\n\nQuem é o *2º funcionário*?`,
      kb(outros.map(f => [{ text: f, callback_data: `func2_${f}` }]))
    );
  }
}

async function handleCallbackFunc2(userId: number, chatId: number, msgId: number, callbackId: string, data: string) {
  await answerCallback(callbackId);
  const func2 = data.replace("func2_", "");
  const session = getSession(userId);

  // Se caminhão ou func1 não existem, volta para seleção de caminhão silenciosamente
  if (!session.caminhao || !session.func1) {
    session.estado = "escolher_caminhao";
    await editMessage(chatId, msgId,
      `🚛 Qual caminhão você está operando hoje?`,
      kb(CAMINHOES.map(c => [{ text: c, callback_data: `caminhao_${c}` }]))
    );
    return;
  }

  const func1 = session.func1 as string;
  session.func2 = func2;
  session.funcionarios = [func1, func2];
  session.estado = "aguardar_pedido";
  await editMessage(chatId, msgId,
    `✅ *Configuração concluída!*\n\n🚛 ${session.caminhao}\n👥 ${func1} e ${func2}\n\nEnvie o *número do pedido* para registrar uma entrega.`
  );
}

async function handleCallbackPoste(userId: number, chatId: number, msgId: number, callbackId: string, data: string) {
  await answerCallback(callbackId);
  const session = getSession(userId);
  session.poste_entregue = data === "poste_sim" ? "Sim" : "Não";
  if (session.poste_entregue === "Sim") {
    session.estado = "aguardar_fotos";
    await editMessage(chatId, msgId,
      "📸 Ótimo! Envie as *fotos da entrega* (mínimo 4 fotos).\n\nQuando terminar, clique em *Concluir Fotos*.",
      kb([[{ text: "✅ Concluir Fotos", callback_data: "fotos_ok" }]])
    );
  } else {
    session.estado = "motivo_nao_entrega";
    await editMessage(chatId, msgId, "❌ Qual foi o *motivo* da não entrega?\n\nDigite abaixo:");
  }
}

async function handleCallbackFotosOk(userId: number, chatId: number, msgId: number, callbackId: string) {
  const session = getSession(userId);
  const fotos = (session.fotos as string[]) || [];
  if (fotos.length < 4) {
    await answerCallback(callbackId, `⚠️ Você enviou apenas ${fotos.length} foto(s). Mínimo 4!`);
    return;
  }
  await answerCallback(callbackId);
  session.estado = "poste_prumo_aguard";
  await editMessage(chatId, msgId,
    `✅ ${fotos.length} fotos recebidas!\n\nO poste foi instalado no *prumo e conforme as normas*?`,
    kb([[{ text: "✅ Sim", callback_data: "prumo_sim" }, { text: "❌ Não", callback_data: "prumo_nao" }]])
  );
}

async function handleCallbackPrumo(userId: number, chatId: number, msgId: number, callbackId: string, data: string) {
  await answerCallback(callbackId);
  const session = getSession(userId);
  session.prumo = data === "prumo_sim" ? "Sim" : "Não";
  session.estado = "fiacao_aguard";
  await editMessage(chatId, msgId,
    "⚡ A *fiação* está completa ou foi entregue separadamente?",
    kb([[{ text: "✅ Completa", callback_data: "fiacao_completa" }, { text: "📦 Separado", callback_data: "fiacao_separado" }]])
  );
}

async function handleCallbackFiacao(userId: number, chatId: number, msgId: number, callbackId: string, data: string) {
  await answerCallback(callbackId);
  const session = getSession(userId);
  if (data === "fiacao_completa") {
    session.fiacao = "Completa";
    session.quem_material = "";
    session.estado = "tampas_aguard";
    await editMessage(chatId, msgId,
      "🔒 As *tampas* foram entregues em perfeitas condições?",
      kb([[{ text: "✅ Sim", callback_data: "tampas_sim" }, { text: "❌ Não", callback_data: "tampas_nao" }]])
    );
  } else {
    session.fiacao = "Entregue Separado";
    session.estado = "quem_material";
    await editMessage(chatId, msgId, "📦 Fiação entregue separado.\n\n*Quem ficou com o material?* Digite o nome:");
  }
}

async function handleCallbackTampas(userId: number, chatId: number, msgId: number, callbackId: string, data: string) {
  await answerCallback(callbackId);
  const session = getSession(userId);
  session.tampas = data === "tampas_sim" ? "Sim" : "Não";
  session.estado = "assinatura_aguard";
  await editMessage(chatId, msgId,
    "✍️ A *assinatura* foi coletada?",
    kb([[{ text: "✅ Sim", callback_data: "assinatura_sim" }, { text: "❌ Não", callback_data: "assinatura_nao" }]])
  );
}

async function handleCallbackAssinatura(userId: number, chatId: number, msgId: number, callbackId: string, data: string, base44: ReturnType<typeof createClientFromRequest>) {
  await answerCallback(callbackId);
  const session = getSession(userId);
  session.assinatura = data === "assinatura_sim" ? "Sim" : "Não";
  await finalizarEntregaNormal(userId, chatId, msgId, session, base44);
}

async function handleCallbackPoliTipo(userId: number, chatId: number, msgId: number, callbackId: string, data: string) {
  await answerCallback(callbackId);
  const session = getSession(userId);
  const tipoMap: Record<string, string> = { tipo_instalacao: "Instalação", tipo_troca: "Troca", tipo_retirada: "Retirada" };
  session.tipo_servico = tipoMap[data] || "";
  session.estado = "poli_num_cacamba";
  const label = session.tipo_servico === "Troca" ? "antiga (a ser trocada)" : "instalada/retirada";
  await editMessage(chatId, msgId, `🔧 *${session.tipo_servico}* selecionado!\n\nQual o *número da caçamba* ${label}?`);
}

// =====================
// ---- FINALIZAR ----
// =====================

async function finalizarEntregaNormal(userId: number, chatId: number, msgId: number | null, session: Record<string, unknown>, base44: ReturnType<typeof createClientFromRequest>) {
  const now = new Date();
  const dataBr = now.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const horaBr = now.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
  const caminhao = (session.caminhao as string) || "Desconhecido";
  const funcs = (session.funcionarios as string[]) || [];
  const pedido = (session.pedido as string) || "";
  const entregue = (session.poste_entregue as string) || "";
  const row = [dataBr, horaBr, caminhao, funcs.join(", "), pedido, entregue,
    (session.prumo as string) || "", (session.fiacao as string) || "", (session.quem_material as string) || "",
    (session.tampas as string) || "", (session.assinatura as string) || "", (session.motivo_nao_entrega as string) || "",
    `${((session.fotos as string[]) || []).length} foto(s)`];
  const token = await getSheetsToken(base44);
  if (token) await appendToSheet(token, caminhao, row);
  const copia = { ...session };
  for (const k of ["pedido", "fotos", "poste_entregue", "prumo", "fiacao", "quem_material", "tampas", "assinatura", "motivo_nao_entrega"]) delete session[k];
  session.estado = "aguardar_pedido";
  await enviarResumoGrupo(copia);
  let resumo = `✅ *Entrega registrada!*\n\n🚛 ${caminhao}\n📦 Pedido: ${pedido}\n`;
  if (entregue === "Sim") {
    resumo += `📐 Prumo: ${copia.prumo || ""}\n⚡ Fiação: ${copia.fiacao || ""}\n`;
    if (copia.quem_material) resumo += `👤 Material: ${copia.quem_material}\n`;
    resumo += `🔒 Tampas: ${copia.tampas || ""}\n✍️ Assinatura: ${copia.assinatura || ""}\n`;
  } else {
    resumo += `❌ Motivo: ${copia.motivo_nao_entrega || ""}\n`;
  }
  resumo += `\n📸 ${((copia.fotos as string[]) || []).length} foto(s)\n\n_Envie o próximo pedido._`;
  if (msgId) await editMessage(chatId, msgId, resumo);
  else await sendMessage(chatId, resumo);
}

async function finalizarPoli(userId: number, chatId: number, session: Record<string, unknown>, base44: ReturnType<typeof createClientFromRequest>) {
  const now = new Date();
  const dataBr = now.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const horaBr = now.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
  const row = [dataBr, horaBr,
    (session.funcionario as string) || "", (session.pedido as string) || "",
    (session.tipo_servico as string) || "", (session.num_cacamba as string) || "",
    (session.num_cacamba_nova as string) || "", "1 foto"];
  const token = await getSheetsToken(base44);
  if (token) await appendToSheet(token, "Caminhão Poli", row, true);
  const copia = { ...session };
  for (const k of ["pedido", "fotos", "tipo_servico", "num_cacamba", "num_cacamba_nova"]) delete session[k];
  session.estado = "aguardar_pedido";
  await enviarResumoGrupo(copia);
  let resumo = `✅ *Serviço registrado!*\n\n🚛 Caminhão Poli\n👤 ${copia.funcionario || ""}\n📦 Pedido: ${copia.pedido || ""}\n🔧 Tipo: ${copia.tipo_servico || ""}\n🗑️ Caçamba: ${copia.num_cacamba || ""}\n`;
  if (copia.num_cacamba_nova) resumo += `🆕 Nova: ${copia.num_cacamba_nova}\n`;
  resumo += "\n_Envie o próximo pedido._";
  await sendMessage(chatId, resumo);
}

// =====================
// ---- TEXTOS ----
// =====================

async function handleInicio(userId: number, chatId: number, text: string) {
  const t = text.toLowerCase().trim();
  const isSaudacao = ["bom dia", "boa tarde", "boa noite", "oi", "olá", "ola", "inicio", "início"].some(s => t.includes(s));
  if (isSaudacao) {
    resetSession(userId);
    const session = getSession(userId);
    session.estado = "escolher_caminhao";
    await sendMessage(chatId, "🚛 Qual caminhão você está operando hoje?", kb(CAMINHOES.map(c => [{ text: c, callback_data: `caminhao_${c}` }])));
  } else {
    await sendMessage(chatId, "👋 Me diga *bom dia* para iniciar o turno 😊");
  }
}

async function handlePedido(userId: number, chatId: number, text: string) {
  const session = getSession(userId);
  const caminhao = session.caminhao as string;
  if (!caminhao) {
    resetSession(userId);
    await sendMessage(chatId, "🚛 Qual caminhão você está operando hoje?", kb(CAMINHOES.map(c => [{ text: c, callback_data: `caminhao_${c}` }])));
    getSession(userId).estado = "escolher_caminhao";
    return;
  }
  session.pedido = text.trim();
  session.fotos = [];
  if (caminhao === "Caminhão Poli") {
    session.estado = "poli_foto";
    await sendMessage(chatId, `📦 Pedido *${text.trim()}* registrado!\n\nAgora envie a *foto* deste serviço 📸`);
  } else {
    session.estado = "poste_entregue_aguard";
    await sendMessage(chatId, `📦 Pedido *${text.trim()}* registrado!\n\nO poste foi entregue?`,
      kb([[{ text: "✅ Sim", callback_data: "poste_sim" }, { text: "❌ Não", callback_data: "poste_nao" }]]));
  }
}

async function handleFotoNormal(userId: number, chatId: number, fileId: string) {
  const session = getSession(userId);
  const fotos = (session.fotos as string[]) || [];
  fotos.push(fileId);
  session.fotos = fotos;
  const num = fotos.length;
  await sendMessage(chatId,
    `📸 Foto ${num} recebida! ${num >= 4 ? "Pode enviar mais ou clicar em *Concluir*." : `Faltam ${4 - num} foto(s).`}`,
    num >= 4 ? kb([[{ text: "✅ Concluir Fotos", callback_data: "fotos_ok" }]]) : undefined
  );
}

async function handlePoliFoto(userId: number, chatId: number, fileId: string, base44: ReturnType<typeof createClientFromRequest>) {
  const session = getSession(userId);
  if (!session.caminhao) {
    resetSession(userId);
    await sendMessage(chatId, "🚛 Qual caminhão você está operando hoje?", kb(CAMINHOES.map(c => [{ text: c, callback_data: `caminhao_${c}` }])));
    getSession(userId).estado = "escolher_caminhao";
    return;
  }
  session.fotos = [fileId];
  const pedido = (session.pedido as string) || "";
  const token = await getSheetsToken(base44);
  const pedidosExistentes = token ? await getPedidosPoli(token) : {};
  const jaInstalado = pedido in pedidosExistentes;
  session.estado = "poli_tipo_aguard";
  if (jaInstalado) {
    await sendMessage(chatId, `📸 Foto recebida!\n\n⚠️ Pedido *${pedido}* já tem instalação. Qual o tipo?`,
      kb([[{ text: "🔄 Troca", callback_data: "tipo_troca" }, { text: "❌ Retirada", callback_data: "tipo_retirada" }]]));
  } else {
    await sendMessage(chatId, "📸 Foto recebida!\n\nQual o tipo de serviço?",
      kb([[{ text: "🆕 Instalação", callback_data: "tipo_instalacao" }, { text: "🔄 Troca", callback_data: "tipo_troca" }, { text: "❌ Retirada", callback_data: "tipo_retirada" }]]));
  }
}

// =====================
// ---- MAIN ----
// =====================

async function processUpdate(update: TelegramUpdate, base44: ReturnType<typeof createClientFromRequest>) {
  // ---- CALLBACKS ----
  if (update.callback_query) {
    const cq = update.callback_query;
    const userId = cq.from.id;
    const chatId = cq.message.chat.id;
    const msgId = cq.message.message_id;
    const data = cq.data;

    if (data.startsWith("caminhao_")) { await handleCallbackCaminhao(userId, chatId, msgId, cq.id, data); }
    else if (data.startsWith("func1_")) { await handleCallbackFunc1(userId, chatId, msgId, cq.id, data); }
    else if (data.startsWith("func2_")) { await handleCallbackFunc2(userId, chatId, msgId, cq.id, data); }
    else if (data === "poste_sim" || data === "poste_nao") { await handleCallbackPoste(userId, chatId, msgId, cq.id, data); }
    else if (data === "fotos_ok") { await handleCallbackFotosOk(userId, chatId, msgId, cq.id); }
    else if (data === "prumo_sim" || data === "prumo_nao") { await handleCallbackPrumo(userId, chatId, msgId, cq.id, data); }
    else if (data === "fiacao_completa" || data === "fiacao_separado") { await handleCallbackFiacao(userId, chatId, msgId, cq.id, data); }
    else if (data === "tampas_sim" || data === "tampas_nao") { await handleCallbackTampas(userId, chatId, msgId, cq.id, data); }
    else if (data === "assinatura_sim" || data === "assinatura_nao") { await handleCallbackAssinatura(userId, chatId, msgId, cq.id, data, base44); }
    else if (data.startsWith("tipo_")) { await handleCallbackPoliTipo(userId, chatId, msgId, cq.id, data); }
    else { await answerCallback(cq.id); }
    return;
  }

  // ---- MENSAGENS ----
  if (!update.message) return;
  const msg = update.message;
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // Detecta grupo automaticamente
  if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
    const title = msg.chat.title?.toLowerCase() || "";
    if (title.includes("entrega") || title.includes("postinho")) GRUPO_ENTREGAS_ID = msg.chat.id;
  }

  // Comandos
  if (msg.text?.startsWith("/setgrupo")) {
    GRUPO_ENTREGAS_ID = chatId;
    await sendMessage(chatId, `✅ Grupo configurado! ID: \`${chatId}\``);
    return;
  }
  if (msg.text?.startsWith("/start")) {
    resetSession(userId);
    await sendMessage(chatId, "👋 Bem-vindo ao *Postinho* 🚛\n\nMe diga *bom dia* para iniciar!");
    return;
  }
  if (msg.text?.startsWith("/status")) {
    const s = getSession(userId);
    await sendMessage(chatId, `ℹ️ *Status*\nCaminhão: ${s.caminhao || "—"}\nFuncionários: ${((s.funcionarios as string[]) || []).join(", ") || "—"}\nEstado: ${s.estado || "inicio"}\nGrupo: ${GRUPO_ENTREGAS_ID || "não configurado"}`);
    return;
  }
  if (msg.text?.startsWith("/reiniciar") || msg.text?.startsWith("/reset")) {
    resetSession(userId);
    await sendMessage(chatId, "🔄 Reiniciado! Me diga *bom dia* para começar.");
    return;
  }

  const session = getSession(userId);
  const estado = (session.estado as string) || "inicio";

  // Foto
  if (msg.photo && msg.photo.length > 0) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    if (estado === "aguardar_fotos") await handleFotoNormal(userId, chatId, fileId);
    else if (estado === "poli_foto") await handlePoliFoto(userId, chatId, fileId, base44);
    else await sendMessage(chatId, "📸 Foto recebida! Envie o *número do pedido* primeiro.");
    return;
  }

  if (!msg.text) return;
  const text = msg.text;
  const t = text.toLowerCase().trim();
  const isSaudacao = ["bom dia", "boa tarde", "boa noite"].some(s => t.includes(s));

  switch (estado) {
    case "inicio":
      await handleInicio(userId, chatId, text);
      break;
    case "escolher_caminhao":
    case "escolher_func1":
    case "escolher_func2":
      if (isSaudacao) await handleInicio(userId, chatId, text);
      else await sendMessage(chatId, "Use os *botões* para escolher 👆");
      break;
    case "aguardar_pedido":
      if (isSaudacao) await handleInicio(userId, chatId, text);
      else await handlePedido(userId, chatId, text);
      break;
    case "motivo_nao_entrega":
      if (isSaudacao) await handleInicio(userId, chatId, text);
      else {
        session.motivo_nao_entrega = text.trim();
        await finalizarEntregaNormal(userId, chatId, null, session, base44);
      }
      break;
    case "quem_material":
      if (isSaudacao) await handleInicio(userId, chatId, text);
      else {
        session.quem_material = text.trim();
        session.estado = "tampas_aguard";
        await sendMessage(chatId, "🔒 As *tampas* foram entregues OK?",
          kb([[{ text: "✅ Sim", callback_data: "tampas_sim" }, { text: "❌ Não", callback_data: "tampas_nao" }]]));
      }
      break;
    case "poli_num_cacamba":
      if (isSaudacao) await handleInicio(userId, chatId, text);
      else {
        session.num_cacamba = text.trim();
        if (session.tipo_servico === "Troca") {
          session.estado = "poli_num_cacamba_nova";
          await sendMessage(chatId, "🔄 Qual o *número da nova caçamba* instalada?");
        } else {
          await finalizarPoli(userId, chatId, session, base44);
        }
      }
      break;
    case "poli_num_cacamba_nova":
      if (isSaudacao) await handleInicio(userId, chatId, text);
      else {
        session.num_cacamba_nova = text.trim();
        await finalizarPoli(userId, chatId, session, base44);
      }
      break;
    case "poste_entregue_aguard":
    case "poste_prumo_aguard":
    case "fiacao_aguard":
    case "tampas_aguard":
    case "assinatura_aguard":
    case "poli_tipo_aguard":
    case "aguardar_fotos":
      if (isSaudacao) await handleInicio(userId, chatId, text);
      else await sendMessage(chatId, "Use os *botões* acima para responder 👆");
      break;
    default:
      await handleInicio(userId, chatId, text);
  }
}

Deno.serve(async (req) => {
  try {
    if (req.method === "GET") return Response.json({ ok: true, status: "Postinho v3 🚛" });
    const base44 = createClientFromRequest(req);
    const update: TelegramUpdate = await req.json();
    await processUpdate(update, base44);
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Erro:", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
});
