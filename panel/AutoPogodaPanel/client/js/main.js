/* global CSInterface, JSZip, require */

var csInterface = new CSInterface();

// ------------------------------------------------------------
// НАСТРОЙКИ — если поменяются коды городов / порядок / имена
// композиций в AE-проекте, править нужно только здесь.
// ------------------------------------------------------------
var CITIES = [
  { name: "Минск",   station: 26850 },
  { name: "Брест",   station: 33008 },
  { name: "Витебск", station: 26666 },
  { name: "Гомель",  station: 33041 },
  { name: "Гродно",  station: 26820 },
  { name: "Могилев", station: 26862 }
];

var CURRENCIES = [
  { code: "USD", label: "Доллар США" },
  { code: "EUR", label: "Евро" },
  { code: "RUB", label: "Российский рубль" }
];

var WIND_STORM_THRESHOLD_MS = 20; // м/с — выше этого считаем "ураган/сильный ветер"

var MONTHS_RU_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
var WEEKDAYS_RU_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

// День выпуска: 0 = сегодня, до BROADCAST_DAYS_AHEAD вперёд. Один общий
// селектор в панели — влияет и на погоду (прогноз на этот день), и на
// блок даты на экране.
var BROADCAST_DAYS_AHEAD = 7;
var selectedDayOffset = 0;

function dateShifted(offsetDays) {
  var d = new Date();
  d.setDate(d.getDate() + (offsetDays || 0));
  return d;
}

function getLocalDateInfoShort(offsetDays) {
  var d = dateShifted(offsetDays);
  return {
    weekday: WEEKDAYS_RU_SHORT[d.getDay()],
    day: d.getDate(),
    month: MONTHS_RU_SHORT[d.getMonth()]
  };
}

// [{offset, label}] на сегодня + BROADCAST_DAYS_AHEAD дней.
function getBroadcastDays() {
  var out = [];
  for (var i = 0; i <= BROADCAST_DAYS_AHEAD; i++) {
    var d = dateShifted(i);
    var human = WEEKDAYS_RU_SHORT[d.getDay()] + " " + d.getDate() + " " + MONTHS_RU_SHORT[d.getMonth()];
    var prefix = i === 0 ? "Сегодня · " : (i === 1 ? "Завтра · " : "");
    out.push({ offset: i, label: prefix + human });
  }
  return out;
}

// ------------------------------------------------------------
// Маппинг на семантический ключ иконки-анимации (2026-08-25, версия 2).
// Раньше брали текст только из fact.code.CutTypeW (weather-fact) — это
// поле пустое (null) в подавляющем большинстве случаев, оно заполняется
// только под явные опасные явления (гроза/ливень/снег и т.п.), а не под
// обычную облачность ("Малооблачно" и т.д.) — из-за этого везде
// показывало "ясно". Нашли настоящий источник — pogoda.by сам берёт
// текст ("Малооблачно", "Облачно" и т.д.) из ДРУГОГО эндпоинта,
// numeric-weather (см. fetchNumericWeatherForCity ниже), поле
// TypeWeather — используем его как основной источник текста, плюс явные
// флаги GROZA/GOLOLED/TUMAN оттуда же (надёжнее, чем парсить текст).
// Ключи соответствуют WEATHER_ICON_COMP_NAMES в host.jsx (там же —
// реальные имена compов анимаций из Animation/Weather Icons CC2014.aep,
// согласовано с пользователем). Порядок проверок важен: сначала самое
// специфичное (гроза/град/шторм, метель/мокрый снег, ливень/морось),
// иначе более общая проверка (напр. "Дожд") перехватит раньше нужной
// ветки.
// ------------------------------------------------------------
function mapWeatherToIcon(fact, numericRec) {
  var cut = (numericRec && numericRec.TypeWeather) || (fact.code && fact.code.CutTypeW) || "";

  // Явные флаги из numeric-weather — надёжнее текста, проверяем первыми.
  if (numericRec) {
    if (numericRec.GROZA) return "storm";
    if (numericRec.GOLOLED) return "cloudy"; // отдельной иконки гололедицы нет
  }

  if (cut.indexOf("Гроза") !== -1) return "storm";
  if (cut.indexOf("Град") !== -1) return "storm";
  if (cut.indexOf("Штормов") !== -1 || cut.indexOf("ураган") !== -1) return "storm";

  if (cut.indexOf("Метель") !== -1) return "snowy";
  if (cut.indexOf("Мокрый снег") !== -1 || cut.indexOf("снег с дожд") !== -1) return "snowy";
  if (cut.indexOf("Снег") !== -1) return "snowy";

  if (cut.indexOf("Морось") !== -1) return "drizzle";
  if (cut.indexOf("Ливень") !== -1 || cut.indexOf("сильный дожд") !== -1) return "rain";
  if (cut.indexOf("Кратковременный дожд") !== -1 || cut.indexOf("местами дожд") !== -1) return "rain_sunny";
  if (cut.indexOf("Дожд") !== -1) return "rain";
  // Прогнозные формулировки numeric-weather: "Временами осадки",
  // "Продолжительные осадки", "Кратковременные осадки" (снег отсеян выше).
  if (cut.indexOf("Кратковременные осадки") !== -1) return "rain_sunny";
  if (cut.indexOf("осадки") !== -1 || cut.indexOf("Осадки") !== -1) return "rain";

  if (cut.indexOf("Шквалист") !== -1) return "windy";

  if (cut.indexOf("Малооблачно") !== -1) return "partly_sunny";
  if (cut.indexOf("Переменная облачность") !== -1) return "partly_cloudy";
  if (cut.indexOf("прояснени") !== -1) return "partly_cloudy";
  if (cut.indexOf("Значительная облачность") !== -1) return "cloudy";
  if (cut.indexOf("Пасмурно") !== -1) return "cloudy";
  if (cut.indexOf("Облачно") !== -1) return "cloudy";
  if (cut.indexOf("Ясно") !== -1) return "sunny";

  if ((numericRec && numericRec.TUMAN) || cut.indexOf("Туман") !== -1) return "cloudy"; // отдельной иконки тумана нет

  if (fact.speedWindMax && fact.speedWindMax >= WIND_STORM_THRESHOLD_MS) return "windy";
  if (numericRec && numericRec.WINDSP_MAX >= WIND_STORM_THRESHOLD_MS) return "windy";

  return "sunny"; // ничего не распознано — считаем ясно (дневной вариант)
}

function formatTemp(t) {
  var rounded = Math.round(t);
  return (rounded >= 0 ? "+" : "") + rounded + "°";
}

// ------------------------------------------------------------
// Запрос погоды через Node.js https (без CORS-ограничений)
// ------------------------------------------------------------
function fetchWeatherForCity(city) {
  return new Promise(function (resolve, reject) {
    var https = require("https");
    var url = "https://pogoda.by/api/v2/weather-fact?station=" + city.station;

    https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "*/*"
      },
      // Локальный антивирус/сетевой фильтр подменяет HTTPS-сертификат
      // (перехват для проверки трафика) — Node из-за этого не доверяет
      // цепочке. Отключаем строгую проверку именно для этого запроса.
      rejectUnauthorized: false
    }, function (res) {
      var data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () {
        try {
          var json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error("Не удалось распарсить ответ для " + city.name));
        }
      });
    }).on("error", function (err) {
      reject(err);
    });
  });
}

// ------------------------------------------------------------
// numeric-weather — второй эндпоинт pogoda.by (тот же id города/станции,
// что и в weather-fact — проверено вручную для всех 6 городов). Отдаёт
// почасовой/12-часовой прогноз с полем TypeWeather ("Малооблачно",
// "Облачно" и т.п.) и явными флагами GROZA/GOLOLED/TUMAN — именно
// отсюда берём текст для mapWeatherToIcon (см. выше), а НЕ из
// weather-fact (там это поле почти всегда пустое).
// ------------------------------------------------------------
function fetchNumericWeatherForCity(city) {
  return new Promise(function (resolve, reject) {
    var https = require("https");
    var url = "https://pogoda.by/api/v2/numeric-weather/12/" + city.station;

    https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "*/*"
      },
      rejectUnauthorized: false // см. комментарий в fetchWeatherForCity
    }, function (res) {
      var data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Не удалось распарсить numeric-weather для " + city.name));
        }
      });
    }).on("error", function (err) {
      reject(err);
    });
  });
}

// Ответ numeric-weather — объект { "дата-строка": { "0": {...}, "12": {...}, ... } }
// (ключ второго уровня — ADVANCE_TIME, смещение в часах от сегодня 00:00).
function extractCurrentNumericRecord(numericData) {
  var dateKeys = Object.keys(numericData || {});
  if (!dateKeys.length) return null;
  var firstDay = numericData[dateKeys[0]];
  var hourKeys = Object.keys(firstDay || {});
  if (!hourKeys.length) return null;
  return firstDay["0"] || firstDay[hourKeys[0]];
}

// ------------------------------------------------------------
// ПРОГНОЗ НА ВЫБРАННЫЙ ДЕНЬ (дневной срок, 12:00)
// ------------------------------------------------------------
// pogoda.by/weather/synoptic использует публичный numeric-weather/12 —
// это и есть числовой прогноз, что показывает раздел «Синоптик» (диапазон
// синоптик чуть сужает вручную, но средняя ≈ TMP). Открытый эндпоинт даёт
// ~6 дней вперёд; для дней за пределами — прочерк.
function fetchNumericWeather12(station) {
  return new Promise(function (resolve, reject) {
    var https = require("https");
    var url = "https://pogoda.by/api/v2/numeric-weather/12/" + station;
    https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "*/*"
      },
      rejectUnauthorized: false // см. комментарий в fetchWeatherForCity
    }, function (res) {
      var data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Не удалось распарсить прогноз для станции " + station)); }
      });
    }).on("error", function (err) { reject(err); });
  });
}

// Запись дневного срока (12:00) для дня dayOffset (0 = сегодня) или null.
function extractDayRecord(numericJson, dayOffset) {
  var dateKeys = Object.keys(numericJson || {});
  if (!dateKeys.length) return null;
  var byOffset = numericJson[dateKeys[0]] || {};
  var wantAdvance = 24 * dayOffset + 12;
  if (byOffset[String(wantAdvance)]) return byOffset[String(wantAdvance)];
  var keys = Object.keys(byOffset);
  for (var i = 0; i < keys.length; i++) {
    var r = byOffset[keys[i]];
    if (r && Number(r.ADVANCE_TIME) === wantAdvance) return r;
  }
  return null;
}

async function fetchAllWeatherForDay(dayOffset) {
  var results = [];
  var missing = 0;
  for (var i = 0; i < CITIES.length; i++) {
    var city = CITIES[i];
    var rec = null;
    try {
      rec = extractDayRecord(await fetchNumericWeather12(city.station), dayOffset);
    } catch (e) { /* город останется без данных */ }
    if (!rec || rec.TMP === undefined || rec.TMP === null) {
      missing++;
      results.push({ city: city.name, temp: "—", icon: "sunny" });
      continue;
    }
    // средняя дневная = (мин+макс)/2 дневного срока (как показывает синоптик:
    // «+21..+23, средняя +22»); если мин/макс нет — TMP (он и так ≈ середина).
    var mid = (typeof rec.TMP_MIN === "number" && typeof rec.TMP_MAX === "number")
      ? (rec.TMP_MIN + rec.TMP_MAX) / 2
      : rec.TMP;
    results.push({
      city: city.name,
      temp: formatTemp(mid),
      icon: mapWeatherToIcon({}, rec) // иконка — из rec.TypeWeather
    });
  }
  if (missing === CITIES.length) {
    throw new Error("Прогноз на этот день недоступен (открытый API pogoda.by даёт ~6 дней вперёд). Выбери день ближе.");
  }
  return results;
}

// ------------------------------------------------------------
// Курс валют — 2026-09-25: источник переключён СТРОГО на страницу
// https://www.nbrb.by/statistics/rates/ratesDaily (по прямому указанию —
// раньше брали JSON api.nbrb.by/exrates/rates, теперь скрейпим ровно то,
// что видно на этой странице глазами).
//
// 1) День — POST-форма страницы принимает поле "Date=YYYY-MM-DD" (виден
//    в value инпута #Date на самой странице) и отдаёт курсы, действовавшие
//    на эту дату. НБ РБ не публикует курс на каждую дату (будущее — пока
//    не объявлено, у формы есть maxDate ~на несколько дней вперёд; более
//    ранняя дата может просто не попасть на публикацию) — если ответ не
//    содержит таблицы курсов вообще, откатываемся на предыдущие дни (до
//    NBRB_RATE_LOOKBACK_DAYS) — так получаем официальный курс, реально
//    действующий на выбранный день.
// 2) Точность — 4 знака после запятой (столько же добавил в шаблон .aep),
//    разделитель — запятая, как на самой странице (там "3,0316", не
//    "3.0316"). Округление — десятично-строковой арифметикой
//    (roundDecimalString), а не Number.toFixed(): JS-число — двоичная
//    дробь, и toFixed на части значений (напр. 1.005) даёт не тот
//    результат, что "на сайте" (см. классику бинарного округления).
// 3) Масштаб (у RUB на странице явно "100 RUB") уже заложен в саму
//    страницу — берём число как есть, привязываясь к 3-буквенному коду
//    валюты, а не к захардкоженной сумме "1"/"100" (сумма перед кодом
//    вычитывается тем же regexp'ом, но не используется для арифметики —
//    только код важен, чтобы найти нужную строку таблицы).
// ------------------------------------------------------------
var NBRB_RATE_LOOKBACK_DAYS = 20; // с запасом покрывает BROADCAST_DAYS_AHEAD (7) + окно публикации вперёд

function isoDateStr(d) {
  var m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + "-" + (m < 10 ? "0" + m : m) + "-" + (day < 10 ? "0" + day : day);
}

// Сырой HTML страницы ratesDaily за конкретный день (POST того же
// запроса, что уходит с формы на странице при выборе даты).
function fetchNbrbDailyPageFor(dateISO) {
  return new Promise(function (resolve, reject) {
    var https = require("https");
    var body = "Date=" + encodeURIComponent(dateISO);
    var req = https.request({
      hostname: "www.nbrb.by",
      path: "/statistics/rates/ratesdaily",
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body)
      },
      rejectUnauthorized: false
    }, function (res) {
      var data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () { resolve(data); });
    });
    req.on("error", function (err) { reject(err); });
    req.write(body);
    req.end();
  });
}

// Строка таблицы на ratesDaily:
//   <td class="curAmount">1 USD</td>
//   <td class="curCours"><div style="text-align:right">3,0316</div></td>
// (у RUB — "100 RUB": масштаб уже часть страницы, не трогаем). Возвращает
// значение курса КАК ЕСТЬ — строкой с запятой, — или null, если валюты
// нет в ответе (напр. страница вообще без таблицы на эту дату).
function extractRateFromDailyPage(html, code) {
  var re = new RegExp(
    'curAmount">\\s*\\d+\\s*' + code + '\\s*</td>\\s*' +
    '<td class="curCours">\\s*<div[^>]*>\\s*([0-9]+(?:[.,][0-9]+)?)\\s*</div>'
  );
  var m = re.exec(html);
  return m ? m[1] : null;
}

// Округление ДЕСЯТИЧНОЙ СТРОКИ (round half up), без перевода в float.
// Разделитель на входе/выходе — точка (используем как внутренний формат,
// на сайте/на выходе для пользователя — запятая, см. fetchCurrencies).
function roundDecimalString(numStr, decimals) {
  var neg = numStr.charAt(0) === "-";
  if (neg) numStr = numStr.slice(1);
  var parts = numStr.split(".");
  var intPart = parts[0] || "0";
  var fracPart = parts[1] || "";
  while (fracPart.length <= decimals) fracPart += "0";
  var keep = fracPart.slice(0, decimals);
  var nextDigit = fracPart.charCodeAt(decimals) - 48;
  var digits = (intPart + keep).split("").map(function (ch) { return ch.charCodeAt(0) - 48; });
  if (nextDigit >= 5) {
    var i = digits.length - 1;
    while (i >= 0) {
      digits[i]++;
      if (digits[i] === 10) { digits[i] = 0; i--; } else { break; }
    }
    if (i < 0) digits.unshift(1);
  }
  var s = digits.join("");
  var intLen = s.length - decimals;
  var result = s.slice(0, intLen) + (decimals ? "." + s.slice(intLen) : "");
  return (neg ? "-" : "") + result;
}

function fetchCurrenciesHtmlForDate(dateObj, triesLeft) {
  return fetchNbrbDailyPageFor(isoDateStr(dateObj)).then(function (html) {
    var hasAny = CURRENCIES.some(function (c) { return extractRateFromDailyPage(html, c.code) !== null; });
    if (hasAny || triesLeft <= 0) return html;
    var prevDay = new Date(dateObj.getTime());
    prevDay.setDate(prevDay.getDate() - 1);
    return fetchCurrenciesHtmlForDate(prevDay, triesLeft - 1);
  });
}

var CURRENCY_DECIMALS = 4;

function fetchCurrencies() {
  return fetchCurrenciesHtmlForDate(dateShifted(selectedDayOffset), NBRB_RATE_LOOKBACK_DAYS).then(function (html) {
    return CURRENCIES.map(function (c) {
      var raw = extractRateFromDailyPage(html, c.code); // строка с запятой либо точкой
      if (!raw) return { code: c.code, label: c.label, rate: "" };
      var rounded = roundDecimalString(raw.replace(",", "."), CURRENCY_DECIMALS);
      return { code: c.code, label: c.label, rate: rounded.replace(".", ",") };
    });
  });
}

// ------------------------------------------------------------
// Парсинг файла новостей/гороскопа: один пункт = один непустой абзац,
// до maxItems штук. 2026-09-25: раньше умели только настоящий .docx
// (ZIP + word/document.xml) — если приносили старый .doc (Word 97-2003,
// двоичный OLE), файл, сохранённый в Блокноте (обычный текст), или из
// другого редактора с иной структурой — ZIP-распаковка падала, текст не
// извлекался ("файл не виден"). Теперь — по сигнатуре первых байтов:
//   - ZIP (PK\x03\x04, т.е. настоящий .docx) или OLE (D0 CF 11 E0,
//     старый .doc) → word-extractor (vendored в client/js/node_modules —
//     чистый JS, без Word/COM, разбирает ОБА формата из Buffer напрямую);
//   - {\rtf → свой лёгкий RTF→текст (ниже);
//   - иначе — обычный текст: UTF-8, а если получилось "грязно" (много
//     символов замены � — не та кодировка) — Windows-1251 (старые
//     файлы/Блокнот на русской Windows).
// ------------------------------------------------------------
function readFileAsArrayBuffer(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(reader.result); };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// Windows-1251, байты 0x80-0xFF -> кодовая точка Unicode (таблица снята
// программно через TextDecoder('windows-1251'), не набрана вручную —
// вручную такую таблицу легко ошибочно набрать и получить "почти
// правильную" кириллицу).
var CP1251_HIGH = [1026, 1027, 8218, 1107, 8222, 8230, 8224, 8225, 8364, 8240, 1033, 8249, 1034, 1036, 1035, 1039,
  1106, 8216, 8217, 8220, 8221, 8226, 8211, 8212, 152, 8482, 1113, 8250, 1114, 1116, 1115, 1119,
  160, 1038, 1118, 1032, 164, 1168, 166, 167, 1025, 169, 1028, 171, 172, 173, 174, 1031,
  176, 177, 1030, 1110, 1169, 181, 182, 183, 1105, 8470, 1108, 187, 1112, 1029, 1109, 1111,
  1040, 1041, 1042, 1043, 1044, 1045, 1046, 1047, 1048, 1049, 1050, 1051, 1052, 1053, 1054, 1055,
  1056, 1057, 1058, 1059, 1060, 1061, 1062, 1063, 1064, 1065, 1066, 1067, 1068, 1069, 1070, 1071,
  1072, 1073, 1074, 1075, 1076, 1077, 1078, 1079, 1080, 1081, 1082, 1083, 1084, 1085, 1086, 1087,
  1088, 1089, 1090, 1091, 1092, 1093, 1094, 1095, 1096, 1097, 1098, 1099, 1100, 1101, 1102, 1103];

function decodeCp1251Byte(b) { return String.fromCodePoint(b < 0x80 ? b : CP1251_HIGH[b - 0x80]); }

function decodeCp1251Buffer(buf) {
  var out = [];
  for (var i = 0; i < buf.length; i++) out.push(decodeCp1251Byte(buf[i]));
  return out.join("");
}

// Декодирует обычный текстовый буфер: UTF-8, а если результат "грязный"
// (заметная доля символов замены � — верный признак не той
// кодировки) — Windows-1251.
function decodeTextBuffer(buf) {
  var utf8 = buf.toString("utf8");
  var bad = (utf8.match(/�/g) || []).length;
  if (bad > 0 && bad > utf8.length * 0.02) return decodeCp1251Buffer(buf);
  return utf8;
}

// Лёгкий RTF -> текст: пропускает служебные группы (таблицы шрифтов/
// цветов, инфо, генератор и т.п.), раскрывает \'hh (Windows-1251) и
// \uN (Unicode), \par/\line -> перевод строки, \tab -> таб, прочие
// управляющие слова — без видимого текста. Не претендует на 100%
// соответствие спецификации RTF — этого достаточно для абзацев текста
// без картинок/таблиц (новости/гороскоп).
var RTF_SKIP_DESTINATIONS = {
  fonttbl: 1, colortbl: 1, stylesheet: 1, info: 1, generator: 1,
  "*": 1, pict: 1, object: 1, footer: 1, header: 1, footnote: 1,
  themedata: 1, colorschememapping: 1, latentstyles: 1, rsid: 1,
  xmlnstbl: 1, listtable: 1, listoverridetable: 1
};

function rtfToText(rtf) {
  var i = 0, n = rtf.length;
  var out = [];
  var groupSkipDepth = -1; // -1 = не в пропускаемой группе, иначе глубина её начала
  var depth = 0;

  function peekControlWord() {
    var neg = false;
    if (rtf[i] === "-") { neg = true; i++; }
    var wordStart = i;
    while (i < n && /[a-zA-Z]/.test(rtf[i])) i++;
    var word = rtf.slice(wordStart, i);
    var numStart = i;
    while (i < n && /[0-9]/.test(rtf[i])) i++;
    var num = rtf.slice(numStart, i);
    if (i < n && rtf[i] === " ") i++; // разделитель после слова/числа поглощается
    return { word: word, num: num ? (neg ? -1 : 1) * parseInt(num, 10) : null };
  }

  while (i < n) {
    var ch = rtf[i];
    if (ch === "{") {
      depth++;
      i++;
      if (rtf[i] === "\\") {
        var save2 = i;
        i++;
        if (rtf[i] === "*") {
          // \* — универсальный "необязательный деструктив" по спецификации
          // RTF: ридер, не знающий, что это, обязан скрыть всю группу.
          // Word прячет за ним почти весь свой служебный балласт (XML-схемы,
          // datastore, генератор, latentstyles и т.п.) — не пытаемся
          // перечислить все конкретные имена, просто доверяем звёздочке.
          if (groupSkipDepth === -1) groupSkipDepth = depth;
        } else {
          var cw = peekControlWord();
          if (groupSkipDepth === -1 && RTF_SKIP_DESTINATIONS[cw.word]) groupSkipDepth = depth;
        }
        i = save2; // откат — само \слово (или \*) обработает основной цикл
      }
      continue;
    }
    if (ch === "}") {
      if (groupSkipDepth === depth) groupSkipDepth = -1;
      depth--;
      i++;
      continue;
    }
    if (ch === "\\") {
      i++;
      if (rtf[i] === "'") {
        i++;
        var hex = rtf.slice(i, i + 2);
        i += 2;
        if (groupSkipDepth === -1) out.push(decodeCp1251Byte(parseInt(hex, 16)));
        continue;
      }
      if (rtf[i] === "\\" || rtf[i] === "{" || rtf[i] === "}") {
        if (groupSkipDepth === -1) out.push(rtf[i]);
        i++;
        continue;
      }
      if (rtf[i] === "\n" || rtf[i] === "\r") { i++; continue; }
      var cw2 = peekControlWord();
      if (cw2.word === "u" && cw2.num !== null) {
        if (groupSkipDepth === -1) out.push(String.fromCodePoint(cw2.num < 0 ? cw2.num + 65536 : cw2.num));
        if (rtf[i] === "?") i++; // запасной ANSI-символ после \uN — пропускаем
        continue;
      }
      if (cw2.word === "par" || cw2.word === "line") {
        if (groupSkipDepth === -1) out.push("\n");
        continue;
      }
      if (cw2.word === "tab") {
        if (groupSkipDepth === -1) out.push("\t");
        continue;
      }
      continue; // прочие управляющие слова — без видимого текста
    }
    if (groupSkipDepth === -1) out.push(ch);
    i++;
  }
  return out.join("");
}

function linesFromText(text, limit) {
  return text.split(/\r\n|\r|\n/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; })
    .slice(0, limit);
}

async function parseDocxParagraphs(file, maxItems) {
  var limit = maxItems || 10; // по умолчанию 10 (новости/именины), гороскоп передаёт 12
  var arrayBuffer = await readFileAsArrayBuffer(file);
  var buffer = Buffer.from(arrayBuffer);

  var isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
  var isOle = buffer.length >= 4 && buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0;
  var isRtf = buffer.slice(0, 5).toString("ascii") === "{\\rtf";

  var text;
  if (isZip) {
    // Настоящий .docx — ПРОВЕРЕННЫЙ годами способ: JSZip (глобальный,
    // подключён тегом <script>, без require() вообще) + вытащить текст из
    // word/document.xml. 2026-09-25: require("word-extractor")/
    // require("./word-extractor.bundle.js") на part машин падали
    // ("Cannot find module") — CEP резолвит require() непредсказуемо от
    // машины к машине. У JSZip такой проблемы нет (не require, а обычный
    // глобальный скрипт) — для основного, ежедневного случая (.docx)
    // возвращаемся на него, чтобы ничего не зависело от require().
    var zip = await JSZip.loadAsync(buffer);
    var xml = await zip.file("word/document.xml").async("string");
    var paraMatches = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
    var items = [];
    for (var i = 0; i < paraMatches.length; i++) {
      var textPieces = paraMatches[i].match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
      var line = textPieces.map(function (t) { return t.replace(/<[^>]+>/g, ""); }).join("").trim();
      if (line) items.push(line);
    }
    return items.slice(0, limit);
  } else if (isOle) {
    // Старый .doc (Word 97-2003) — best-effort через word-extractor.
    // Абсолютный путь через CSInterface (не require()-специфер и не
    // относительный путь — оба ненадёжны в CEP) — но если и это не
    // сработает на какой-то машине, ошибка не должна мешать обычным
    // .docx (та ветка выше их вообще не касается).
    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);
    var WordExtractor = require(extRoot + "/client/js/word-extractor.bundle.js");
    var doc = await new WordExtractor().extract(buffer);
    text = doc.getBody();
  } else if (isRtf) {
    text = rtfToText(buffer.toString("ascii"));
  } else {
    text = decodeTextBuffer(buffer);
  }

  return linesFromText(text, limit);
}

// ------------------------------------------------------------
// Вызов ExtendScript
// ------------------------------------------------------------
function escapeForEvalScript(jsonStr) {
  return jsonStr.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/[\r\n]/g, " ");
}

function callHost(functionName, jsonArg) {
  return new Promise(function (resolve) {
    var escaped = escapeForEvalScript(JSON.stringify(jsonArg));
    var script = functionName + "('" + escaped + "')";
    csInterface.evalScript(script, function (result) {
      resolve(result);
    });
  });
}

// ------------------------------------------------------------
// Редактируемые превью-списки — общий helper. Каждый элемент
// массива рисуется как строка полей (input/textarea), значения
// читаются обратно перед отправкой в host.jsx — так пользователь
// видит и может поправить КАЖДЫЙ пункт до того, как он уйдёт в AE.
// ------------------------------------------------------------
function renderEditableRows(container, rows, fields) {
  container.innerHTML = "";
  rows.forEach(function (row) {
    var rowEl = document.createElement("div");
    rowEl.className = "edit-row";
    fields.forEach(function (f) {
      var val = row[f.key] != null ? row[f.key] : (f.button ? (f.cycle && f.cycle[0]) || "" : "");
      if (f.readonly) {
        var span = document.createElement("span");
        span.className = "edit-label";
        span.dataset.key = f.key;
        span.dataset.value = val;
        span.textContent = val;
        rowEl.appendChild(span);
        return;
      }
      if (f.select) {
        // Выпадающий список (напр. иконка погоды) — значение читается
        // как обычное поле (el.value), readEditableRows ничего доп. не
        // требует.
        var select = document.createElement("select");
        select.className = "edit-field";
        select.dataset.key = f.key;
        (f.options || []).forEach(function (opt) {
          var optionEl = document.createElement("option");
          optionEl.value = opt.value;
          optionEl.textContent = opt.label;
          if (opt.value === val) optionEl.selected = true;
          select.appendChild(optionEl);
        });
        rowEl.appendChild(select);
        return;
      }
      if (f.button) {
        // Маленькая кнопка-переключатель (напр. режим 1/2 строки) — по
        // клику циклически меняет значение по списку f.cycle, само
        // значение хранится в dataset.value (как у readonly-полей).
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "edit-toggle-btn";
        btn.dataset.key = f.key;
        btn.dataset.value = val;
        btn.textContent = (f.labels && f.labels[val]) || val;
        btn.addEventListener("click", function () {
          var cycle = f.cycle || [];
          var idx = cycle.indexOf(btn.dataset.value);
          var next = cycle[(idx + 1) % cycle.length];
          btn.dataset.value = next;
          btn.textContent = (f.labels && f.labels[next]) || next;
        });
        rowEl.appendChild(btn);
        return;
      }
      var input = document.createElement(f.textarea ? "textarea" : "input");
      if (!f.textarea) input.type = f.hidden ? "hidden" : "text";
      input.className = "edit-field";
      input.dataset.key = f.key;
      input.value = val;
      if (f.placeholder) input.placeholder = f.placeholder;
      if (f.width) input.style.width = f.width;
      rowEl.appendChild(input);
    });
    container.appendChild(rowEl);
  });
}

function readEditableRows(container, fields) {
  var rowEls = container.querySelectorAll(".edit-row");
  var rows = [];
  rowEls.forEach(function (rowEl) {
    var row = {};
    fields.forEach(function (f) {
      var el = rowEl.querySelector('[data-key="' + f.key + '"]');
      row[f.key] = el ? ((f.readonly || f.button) ? el.dataset.value : el.value) : "";
    });
    rows.push(row);
  });
  return rows;
}

// Статус — маленькая иконка (✓/!) вместо строки текста (2026-08-25):
// полный текст живёт в title (тултип при наведении) и копируется по
// клику — сама строка нигде не отображается как текст.
function copyToClipboard(text) {
  // Classic execCommand-приём, а не navigator.clipboard — буфер обмена
  // через Clipboard API требует "secure context" (https/localhost),
  // а панель открывается по file:// — там его может не быть.
  try {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return true;
  } catch (e) {
    return false;
  }
}

function setStatus(elId, text, isError) {
  var el = document.getElementById(elId);
  el.textContent = isError ? "!" : "✓";
  el.title = text;
  el.dataset.fullText = text;
  el.className = "status-icon" + (isError ? " error" : " ok");
}

// callHost() никогда не реджектит промис на ошибку из host.jsx — evalScript
// всегда резолвит колбэк, даже если ExtendScript-функция вернула
// "ERROR: ...". Раньше это шло прямиком в setStatus(..., "Готово: "+result)
// без проверки — красная иконка не загоралась, хотя в тексте была ошибка.
// Единая точка: сюда отдаём "сырой" result от callHost, сама решает ✓/!.
function showResult(elId, result) {
  var text = String(result);
  var isErr = text.indexOf("ERROR") === 0;
  setStatus(elId, (isErr ? "Ошибка: " : "Готово: ") + text, isErr);
}

// Один обработчик клика на все иконки-статусы сразу (делегирование) —
// копирует в буфер полный текст последнего результата этого блока.
document.addEventListener("click", function (e) {
  var el = e.target.closest ? e.target.closest(".status-icon") : null;
  if (!el || !el.dataset.fullText) return;
  copyToClipboard(el.dataset.fullText);
});

// ------------------------------------------------------------
// Общая обвязка для "кнопка сама фетчит данные и сразу применяет
// их в AE" (погода / курс валют / дата) + отдельная маленькая
// кнопка "Применить правки" — переотправляет то, что сейчас стоит
// в полях превью, БЕЗ повторного запроса, на случай если данные
// поправили вручную уже после автозагрузки.
// ------------------------------------------------------------
function wireFetchApplySection(opts) {
  var btn = document.getElementById(opts.btnId);
  var applyBtn = opts.applyEditsBtnId ? document.getElementById(opts.applyEditsBtnId) : null;
  var previewEl = document.getElementById(opts.previewId);

  function toHostArgs(rows) {
    return opts.toHostArgs ? opts.toHostArgs(rows) : rows;
  }

  btn.addEventListener("click", async function () {
    setStatus(opts.statusId, "Загружаю...");
    try {
      var rows = await opts.fetchFn();
      renderEditableRows(previewEl, rows, opts.fields);
      var result = await callHost(opts.hostFn, toHostArgs(rows));
      showResult(opts.statusId, result);
    } catch (e) {
      setStatus(opts.statusId, "Ошибка: " + e.message, true);
    }
  });

  if (applyBtn) {
    applyBtn.addEventListener("click", async function () {
      var rows = readEditableRows(previewEl, opts.fields);
      if (!rows.length) { setStatus(opts.statusId, "Сначала нажми основную кнопку выше — нечего применять.", true); return; }
      setStatus(opts.statusId, "Применяю правки...");
      try {
        var result = await callHost(opts.hostFn, toHostArgs(rows));
        showResult(opts.statusId, result);
      } catch (e) {
        setStatus(opts.statusId, "Ошибка: " + e.message, true);
      }
    });
  }
}

// ------------------------------------------------------------
// Погода
// ------------------------------------------------------------
// Короткие человеческие подписи для 10 состояний иконки-анимации (ключи
// см. WEATHER_ICON_COMP_NAMES в host.jsx) — чтобы можно было руками
// поправить погоду/иконку прямо в панели, если авто-определение
// ошиблось.
var WEATHER_ICON_OPTIONS = [
  { value: "sunny", label: "Ясно" },
  { value: "partly_sunny", label: "Малооблачно" },
  { value: "partly_cloudy", label: "Переменная обл." },
  { value: "cloudy", label: "Облачно" },
  { value: "drizzle", label: "Морось" },
  { value: "rain", label: "Дождь" },
  { value: "rain_sunny", label: "Кратк. дождь" },
  { value: "snowy", label: "Снег" },
  { value: "storm", label: "Гроза" },
  { value: "windy", label: "Ветер" }
];

var WEATHER_FIELDS = [
  { key: "city", placeholder: "Город" },
  { key: "temp", placeholder: "Темп.", width: "70px" },
  { key: "icon", select: true, options: WEATHER_ICON_OPTIONS }
];
wireFetchApplySection({
  btnId: "btnWeather",
  applyEditsBtnId: "btnWeatherApplyEdits",
  statusId: "weatherStatus",
  previewId: "weatherPreview",
  fields: WEATHER_FIELDS,
  fetchFn: function () { return fetchAllWeatherForDay(selectedDayOffset); },
  hostFn: "buildWeatherCycleTimeline"
});

// ------------------------------------------------------------
// Курс валют
// ------------------------------------------------------------
var CURRENCY_FIELDS = [
  { key: "code", hidden: true },
  { key: "label", readonly: true },
  { key: "rate", placeholder: "Курс", width: "80px" }
];
wireFetchApplySection({
  btnId: "btnCurrency",
  applyEditsBtnId: "btnCurrencyApplyEdits",
  statusId: "currencyStatus",
  previewId: "currencyPreview",
  fields: CURRENCY_FIELDS,
  fetchFn: fetchCurrencies,
  hostFn: "applyCurrencyRates"
});

// ------------------------------------------------------------
// Дата / день недели — значение подтягивается локально (без сети)
// автоматически при открытии панели, отправка в AE — по кнопке.
// ------------------------------------------------------------
var DATE_FIELDS = [
  { key: "weekday", placeholder: "День недели", width: "70px" },
  { key: "day", placeholder: "Число", width: "50px" },
  { key: "month", placeholder: "Месяц", width: "70px" }
];
wireFetchApplySection({
  btnId: "btnDate",
  applyEditsBtnId: "btnDateApplyEdits",
  statusId: "dateStatus",
  previewId: "datePreview",
  fields: DATE_FIELDS,
  fetchFn: function () { return Promise.resolve([getLocalDateInfoShort(selectedDayOffset)]); },
  hostFn: "applyDateInfo",
  toHostArgs: function (rows) { return rows[0] || {}; } // host ждёт один объект, не массив
});

function refreshDatePreview() {
  renderEditableRows(document.getElementById("datePreview"), [getLocalDateInfoShort(selectedDayOffset)], DATE_FIELDS);
}
// Заполняем превью сразу при открытии панели — не дожидаясь клика,
// в AE при этом ничего не отправляем (для этого нужна кнопка).
refreshDatePreview();

// Селектор дня выпуска — один на всё: меняет и погоду (по кнопке «Обновить
// погоду»), и превью даты (сразу).
(function initBroadcastDaySelector() {
  var sel = document.getElementById("broadcastDay");
  if (!sel) return;
  var days = getBroadcastDays();
  for (var i = 0; i < days.length; i++) {
    var opt = document.createElement("option");
    opt.value = String(days[i].offset);
    opt.textContent = days[i].label;
    sel.appendChild(opt);
  }
  sel.value = "0";
  sel.addEventListener("change", function () {
    selectedDayOffset = parseInt(sel.value, 10) || 0;
    refreshDatePreview();
  });
})();

// ------------------------------------------------------------
// Новости — файл выбирается → сразу парсится и показывается
// редактируемым списком; кнопка "Загрузить новости" отправляет
// то, что сейчас стоит в полях (исходное или уже поправленное).
// ------------------------------------------------------------
var NEWS_FIELDS = [
  { key: "num", readonly: true },
  { key: "text", textarea: true, placeholder: "Текст новости" },
  // Кнопка справа от каждой новости: авто (как решит host.jsx по числу
  // слов) / принудительно 1 строка / принудительно 2 строки. Если в самом
  // тексте руками поставлен перенос строки — он побеждает оба режима.
  { key: "mode", button: true, cycle: ["auto", "1", "2"], labels: { auto: "авто", "1": "1 стр.", "2": "2 стр." } }
];

document.getElementById("docxFile").addEventListener("change", async function (e) {
  var file = e.target.files[0];
  if (!file) return;
  try {
    var items = await parseDocxParagraphs(file, 6); // 6 новостей (было 10)
    renderEditableRows(document.getElementById("newsPreview"), items.map(function (t, i) { return { text: t, num: (i + 1) + "." }; }), NEWS_FIELDS);
    document.getElementById("btnNews").disabled = false;
    setStatus("newsStatus", "Найдено новостей: " + items.length);
  } catch (err) {
    setStatus("newsStatus", "Ошибка чтения docx: " + err.message, true);
  }
});

document.getElementById("btnNews").addEventListener("click", async function () {
  var rows = readEditableRows(document.getElementById("newsPreview"), NEWS_FIELDS);
  if (!rows.length) { setStatus("newsStatus", "Сначала выбери файл новостей.", true); return; }
  setStatus("newsStatus", "Загружаю в проект...");
  try {
    var result = await callHost("applyNewsItems", rows.map(function (r) { return { text: r.text, mode: r.mode || "auto" }; }));
    showResult("newsStatus", result);
  } catch (e) {
    setStatus("newsStatus", "Ошибка: " + e.message, true);
  }
});

// ------------------------------------------------------------
// Именины — одна строка, имена через запятую (2026-08-25). Правило
// количества строк на плашке — считает host.jsx: 1-4 имени -> 1 строка,
// 5-8 -> 2 строки. Перенос строки (Enter), если пользователь поставил
// его сам в этом поле — явно указывает, где кончается 1-я строка и
// начинается 2-я (побеждает авто-правило 1-4/5-8 целиком) — тот же
// принцип, что и в новостях/гороскопе. Поэтому отправляем RAW-текст поля
// как есть (host.jsx сам решает, резать по \n или считать имена по
// запятым) — никакого предварительного разбора на массив имён тут.
//
// Автоматический источник имён: kalendarik.com.ua/kalendar-imenin сам
// берёт данные из ПУБЛИЧНОГО Google-календаря через встроенный виджет
// fullCalendar (нашли, посмотрев исходный код их страницы). Первая
// попытка — дёрнуть Google Calendar API прямо отсюда (fetch с подделанным
// Referer) — не сработала (403: CEF режет referrer-override для
// чужого origin). Поэтому сам запрос теперь делает host.jsx через
// system.callSystem()+curl.exe (обычный процесс ОС, никаких
// browser-ограничений) — тут только просим его и разбираем результат.

// Простой случайный выбор N элементов без повторов.
function pickRandom(arr, n) {
  var copy = arr.slice();
  var picked = [];
  while (copy.length && picked.length < n) {
    var idx = Math.floor(Math.random() * copy.length);
    picked.push(copy.splice(idx, 1)[0]);
  }
  return picked;
}

// yyyy-mm-dd выбранного дня выпуска.
function selectedDateISO() {
  var d = dateShifted(selectedDayOffset);
  var m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + "-" + (m < 10 ? "0" + m : m) + "-" + (day < 10 ? "0" + day : day);
}

document.getElementById("btnBdayFetch").addEventListener("click", async function () {
  var iso = selectedDateISO();
  setStatus("bdayStatus", "Загружаю имена на " + iso + "...");
  try {
    var raw = await callHost("fetchNamedaysToday", { dateISO: iso });
    if (raw.indexOf("ERROR") === 0) { setStatus("bdayStatus", raw, true); return; }
    var all = JSON.parse(raw);
    if (!all.length) { setStatus("bdayStatus", "Имён на " + iso + " не найдено (пустой ответ).", true); return; }
    var picked = pickRandom(all, 8);
    document.getElementById("bdayNamesInput").value = picked.join(", ");
    setStatus("bdayStatus", "Найдено " + all.length + " имён на " + iso + ", выбрано случайных 8 — можно поправить перед загрузкой.");
  } catch (e) {
    setStatus("bdayStatus", "Ошибка получения имён: " + e.message, true);
  }
});

document.getElementById("btnBirthday").addEventListener("click", async function () {
  var raw = document.getElementById("bdayNamesInput").value || "";
  if (!raw.trim()) { setStatus("bdayStatus", "Сначала впиши имена через запятую.", true); return; }
  setStatus("bdayStatus", "Загружаю в проект...");
  try {
    var result = await callHost("applyBirthdayNames", raw);
    showResult("bdayStatus", result);
  } catch (e) {
    setStatus("bdayStatus", "Ошибка: " + e.message, true);
  }
});

// ------------------------------------------------------------
// Гороскоп — тот же паттерн, что новости/именины: файл выбирается →
// сразу парсится и показывается редактируемым списком; кнопка
// "Загрузить гороскоп" отправляет то, что сейчас стоит в полях.
// ------------------------------------------------------------
var HOROSCOPE_FIELDS = [
  { key: "num", readonly: true },
  { key: "text", textarea: true, placeholder: "Текст гороскопа" },
  { key: "mode", button: true, cycle: ["auto", "1", "2"], labels: { auto: "авто", "1": "1 стр.", "2": "2 стр." } }
];

document.getElementById("horoscopeFile").addEventListener("change", async function (e) {
  var file = e.target.files[0];
  if (!file) return;
  try {
    var items = await parseDocxParagraphs(file, 12);
    renderEditableRows(document.getElementById("horoscopePreview"), items.map(function (t, i) { return { text: t, num: (i + 1) + "." }; }), HOROSCOPE_FIELDS);
    document.getElementById("btnHoroscope").disabled = false;
    setStatus("horoscopeStatus", "Найдено гороскопов: " + items.length);
  } catch (err) {
    setStatus("horoscopeStatus", "Ошибка чтения docx: " + err.message, true);
  }
});

document.getElementById("btnHoroscope").addEventListener("click", async function () {
  var rows = readEditableRows(document.getElementById("horoscopePreview"), HOROSCOPE_FIELDS);
  if (!rows.length) { setStatus("horoscopeStatus", "Сначала выбери файл гороскопа.", true); return; }
  setStatus("horoscopeStatus", "Загружаю в проект...");
  try {
    var result = await callHost("applyHoroscopeItems", rows.map(function (r) { return { text: r.text, mode: r.mode || "auto" }; }));
    showResult("horoscopeStatus", result);
  } catch (e) {
    setStatus("horoscopeStatus", "Ошибка: " + e.message, true);
  }
});

// Одна кнопка на все переходы сразу (2026-08-25, раньше было 2 отдельные
// — "все блоки" и "пункты+валюта"; 2026-08-29 — сюда же добавили погоду,
// отдельную кнопку "Анимация погоды" убрали из панели за ненадобностью).
document.getElementById("btnAllTransitions").addEventListener("click", async function () {
  setStatus("allTransitionsStatus", "Настраиваю переходы...");
  try {
    var results = [];
    var weatherRows = readEditableRows(document.getElementById("weatherPreview"), WEATHER_FIELDS);
    if (weatherRows.length) {
      var weatherResult = await callHost("applyWeatherTransitions", weatherRows);
      results.push("ПОГОДА: " + weatherResult);
    }
    var result = await callHost("applyAllTransitionsCombined", {});
    results.push(result);
    showResult("allTransitionsStatus", results.join(" || "));
  } catch (e) {
    setStatus("allTransitionsStatus", "Ошибка: " + e.message, true);
  }
});

