var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// node_modules/word-extractor/lib/ole-header.js
var require_ole_header = __commonJS({
  "node_modules/word-extractor/lib/ole-header.js"(exports2, module2) {
    var HEADER_DATA = Buffer.from("D0CF11E0A1B11AE1", "hex");
    var Header = class {
      constructor() {
      }
      load(buffer) {
        for (let i = 0; i < HEADER_DATA.length; i++) {
          if (HEADER_DATA[i] != buffer[i])
            return false;
        }
        this.secSize = 1 << buffer.readInt16LE(30);
        this.shortSecSize = 1 << buffer.readInt16LE(32);
        this.SATSize = buffer.readInt32LE(44);
        this.dirSecId = buffer.readInt32LE(48);
        this.shortStreamMax = buffer.readInt32LE(56);
        this.SSATSecId = buffer.readInt32LE(60);
        this.SSATSize = buffer.readInt32LE(64);
        this.MSATSecId = buffer.readInt32LE(68);
        this.MSATSize = buffer.readInt32LE(72);
        this.partialMSAT = new Array(109);
        for (let i = 0; i < 109; i++)
          this.partialMSAT[i] = buffer.readInt32LE(76 + i * 4);
        return true;
      }
    };
    module2.exports = Header;
  }
});

// node_modules/word-extractor/lib/ole-allocation-table.js
var require_ole_allocation_table = __commonJS({
  "node_modules/word-extractor/lib/ole-allocation-table.js"(exports2, module2) {
    var ALLOCATION_TABLE_SEC_ID_FREE = -1;
    var AllocationTable = class {
      constructor(doc) {
        this._doc = doc;
      }
      load(secIds) {
        const doc = this._doc;
        const header = doc._header;
        this._table = new Array(secIds.length * (header.secSize / 4));
        return doc._readSectors(secIds).then((buffer) => {
          for (let i = 0; i < buffer.length / 4; i++) {
            this._table[i] = buffer.readInt32LE(i * 4);
          }
        });
      }
      getSecIdChain(startSecId) {
        let secId = startSecId;
        const secIds = [];
        while (secId > ALLOCATION_TABLE_SEC_ID_FREE) {
          secIds.push(secId);
          const secIdPrior = secId;
          secId = this._table[secId];
          if (secId === secIdPrior) {
            break;
          }
        }
        return secIds;
      }
    };
    module2.exports = AllocationTable;
  }
});

// node_modules/word-extractor/lib/ole-directory-tree.js
var require_ole_directory_tree = __commonJS({
  "node_modules/word-extractor/lib/ole-directory-tree.js"(exports2, module2) {
    var DIRECTORY_TREE_ENTRY_TYPE_STORAGE = 1;
    var DIRECTORY_TREE_ENTRY_TYPE_STREAM = 2;
    var DIRECTORY_TREE_ENTRY_TYPE_ROOT = 5;
    var DIRECTORY_TREE_LEAF = -1;
    var DirectoryTree = class {
      constructor(doc) {
        this._doc = doc;
      }
      load(secIds) {
        const doc = this._doc;
        return doc._readSectors(secIds).then((buffer) => {
          const count = buffer.length / 128;
          this._entries = new Array(count);
          for (let i = 0; i < count; i++) {
            const offset = i * 128;
            const nameLength = Math.max(buffer.readInt16LE(64 + offset) - 1, 0);
            const entry = {};
            entry.name = buffer.toString("utf16le", 0 + offset, nameLength + offset);
            entry.type = buffer.readInt8(66 + offset);
            entry.nodeColor = buffer.readInt8(67 + offset);
            entry.left = buffer.readInt32LE(68 + offset);
            entry.right = buffer.readInt32LE(72 + offset);
            entry.storageDirId = buffer.readInt32LE(76 + offset);
            entry.secId = buffer.readInt32LE(116 + offset);
            entry.size = buffer.readInt32LE(120 + offset);
            this._entries[i] = entry;
          }
          this.root = this._entries.find((entry) => entry.type === DIRECTORY_TREE_ENTRY_TYPE_ROOT);
          this._buildHierarchy(this.root);
        });
      }
      _buildHierarchy(storageEntry) {
        const childIds = this._getChildIds(storageEntry);
        storageEntry.storages = {};
        storageEntry.streams = {};
        for (const childId of childIds) {
          const childEntry = this._entries[childId];
          const name = childEntry.name;
          if (childEntry.type === DIRECTORY_TREE_ENTRY_TYPE_STORAGE) {
            storageEntry.storages[name] = childEntry;
          }
          if (childEntry.type === DIRECTORY_TREE_ENTRY_TYPE_STREAM) {
            storageEntry.streams[name] = childEntry;
          }
        }
        for (const name in storageEntry.storages) {
          this._buildHierarchy(storageEntry.storages[name]);
        }
      }
      _getChildIds(storageEntry) {
        const childIds = [];
        const visit = (visitEntry) => {
          if (visitEntry.left !== DIRECTORY_TREE_LEAF) {
            childIds.push(visitEntry.left);
            visit(this._entries[visitEntry.left]);
          }
          if (visitEntry.right !== DIRECTORY_TREE_LEAF) {
            childIds.push(visitEntry.right);
            visit(this._entries[visitEntry.right]);
          }
        };
        if (storageEntry.storageDirId > -1) {
          childIds.push(storageEntry.storageDirId);
          const rootChildEntry = this._entries[storageEntry.storageDirId];
          visit(rootChildEntry);
        }
        return childIds;
      }
    };
    module2.exports = DirectoryTree;
  }
});

// node_modules/word-extractor/lib/ole-storage-stream.js
var require_ole_storage_stream = __commonJS({
  "node_modules/word-extractor/lib/ole-storage-stream.js"(exports2, module2) {
    var { Readable } = require("stream");
    var StorageStream = class extends Readable {
      constructor(doc, streamEntry) {
        super();
        this._doc = doc;
        this._streamEntry = streamEntry;
        this.initialize();
      }
      initialize() {
        this._index = 0;
        this._done = true;
        if (!this._streamEntry) {
          return;
        }
        const doc = this._doc;
        this._bytes = this._streamEntry.size;
        this._allocationTable = doc._SAT;
        this._shortStream = false;
        if (this._bytes < doc._header.shortStreamMax) {
          this._shortStream = true;
          this._allocationTable = doc._SSAT;
        }
        this._secIds = this._allocationTable.getSecIdChain(this._streamEntry.secId);
        this._done = false;
      }
      _readSector(sector) {
        if (this._shortStream) {
          return this._doc._readShortSector(sector);
        } else {
          return this._doc._readSector(sector);
        }
      }
      _read() {
        if (this._done) {
          return this.push(null);
        }
        if (this._index >= this._secIds.length) {
          this._done = true;
          return this.push(null);
        }
        return this._readSector(this._secIds[this._index]).then((buffer) => {
          if (this._bytes - buffer.length < 0) {
            buffer = buffer.slice(0, this._bytes);
          }
          this._bytes -= buffer.length;
          this._index++;
          this.push(buffer);
        });
      }
    };
    module2.exports = StorageStream;
  }
});

// node_modules/word-extractor/lib/ole-storage.js
var require_ole_storage = __commonJS({
  "node_modules/word-extractor/lib/ole-storage.js"(exports2, module2) {
    var StorageStream = require_ole_storage_stream();
    var Storage = class _Storage {
      constructor(doc, dirEntry) {
        this._doc = doc;
        this._dirEntry = dirEntry;
      }
      storage(storageName) {
        return new _Storage(this._doc, this._dirEntry.storages[storageName]);
      }
      stream(streamName) {
        return new StorageStream(this._doc, this._dirEntry.streams[streamName]);
      }
    };
    module2.exports = Storage;
  }
});

// node_modules/word-extractor/lib/ole-compound-doc.js
var require_ole_compound_doc = __commonJS({
  "node_modules/word-extractor/lib/ole-compound-doc.js"(exports2, module2) {
    var Header = require_ole_header();
    var AllocationTable = require_ole_allocation_table();
    var DirectoryTree = require_ole_directory_tree();
    var Storage = require_ole_storage();
    var OleCompoundDoc = class {
      constructor(reader) {
        this._reader = reader;
        this._skipBytes = 0;
      }
      read() {
        return Promise.resolve().then(() => this._readHeader()).then(() => this._readMSAT()).then(() => this._readSAT()).then(() => this._readSSAT()).then(() => this._readDirectoryTree()).then(() => {
          if (this._skipBytes != 0) {
            return this._readCustomHeader();
          }
        }).then(() => this);
      }
      _readCustomHeader() {
        const buffer = Buffer.alloc(this._skipBytes);
        return this._reader.read(buffer, 0, this._skipBytes, 0).then((buffer2) => {
          if (!this._customHeaderCallback(buffer2))
            return;
        });
      }
      _readHeader() {
        const buffer = Buffer.alloc(512);
        return this._reader.read(buffer, 0, 512, 0 + this._skipBytes).then((buffer2) => {
          const header = this._header = new Header();
          if (!header.load(buffer2)) {
            throw new Error("Not a valid compound document");
          }
        });
      }
      _readMSAT() {
        const header = this._header;
        this._MSAT = header.partialMSAT.slice(0);
        this._MSAT.length = header.SATSize;
        if (header.SATSize <= 109 || header.MSATSize == 0) {
          return Promise.resolve();
        }
        let currMSATIndex = 109;
        let i = 0;
        const readOneMSAT = (i2, currMSATIndex2, secId) => {
          if (i2 >= header.MSATSize) {
            return Promise.resolve();
          }
          return this._readSector(secId).then((sectorBuffer) => {
            let s;
            for (s = 0; s < header.secSize - 4; s += 4) {
              if (currMSATIndex2 >= header.SATSize)
                break;
              else
                this._MSAT[currMSATIndex2] = sectorBuffer.readInt32LE(s);
              currMSATIndex2++;
            }
            secId = sectorBuffer.readInt32LE(header.secSize - 4);
            return readOneMSAT(i2 + 1, currMSATIndex2, secId);
          });
        };
        return readOneMSAT(i, currMSATIndex, header.MSATSecId);
      }
      _readSector(secId) {
        return this._readSectors([secId]);
      }
      _readSectors(secIds) {
        const header = this._header;
        const buffer = Buffer.alloc(secIds.length * header.secSize);
        const readOneSector = (i) => {
          if (i >= secIds.length) {
            return Promise.resolve(buffer);
          }
          const bufferOffset = i * header.secSize;
          const fileOffset = this._getFileOffsetForSec(secIds[i]);
          return this._reader.read(buffer, bufferOffset, header.secSize, fileOffset).then(() => readOneSector(i + 1));
        };
        return readOneSector(0);
      }
      _readShortSector(secId) {
        return this._readShortSectors([secId]);
      }
      _readShortSectors(secIds) {
        const header = this._header;
        const buffer = Buffer.alloc(secIds.length * header.shortSecSize);
        const readOneShortSector = (i) => {
          if (i >= secIds.length) {
            return Promise.resolve(buffer);
          }
          const bufferOffset = i * header.shortSecSize;
          const fileOffset = this._getFileOffsetForShortSec(secIds[i]);
          return this._reader.read(buffer, bufferOffset, header.shortSecSize, fileOffset).then(() => readOneShortSector(i + 1));
        };
        return readOneShortSector(0);
      }
      _readSAT() {
        this._SAT = new AllocationTable(this);
        return this._SAT.load(this._MSAT);
      }
      _readSSAT() {
        const header = this._header;
        const secIds = this._SAT.getSecIdChain(header.SSATSecId);
        if (secIds.length != header.SSATSize) {
          return Promise.reject(new Error("Invalid Short Sector Allocation Table"));
        }
        this._SSAT = new AllocationTable(this);
        return this._SSAT.load(secIds);
      }
      _readDirectoryTree() {
        const header = this._header;
        this._directoryTree = new DirectoryTree(this);
        const secIds = this._SAT.getSecIdChain(header.dirSecId);
        return this._directoryTree.load(secIds).then(() => {
          const rootEntry = this._directoryTree.root;
          this._rootStorage = new Storage(this, rootEntry);
          this._shortStreamSecIds = this._SAT.getSecIdChain(rootEntry.secId);
        });
      }
      _getFileOffsetForSec(secId) {
        const secSize = this._header.secSize;
        return this._skipBytes + (secId + 1) * secSize;
      }
      _getFileOffsetForShortSec(shortSecId) {
        const shortSecSize = this._header.shortSecSize;
        const shortStreamOffset = shortSecId * shortSecSize;
        const secSize = this._header.secSize;
        const secIdIndex = Math.floor(shortStreamOffset / secSize);
        const secOffset = shortStreamOffset % secSize;
        const secId = this._shortStreamSecIds[secIdIndex];
        return this._getFileOffsetForSec(secId) + secOffset;
      }
      storage(storageName) {
        return this._rootStorage.storage(storageName);
      }
      stream(streamName) {
        return this._rootStorage.stream(streamName);
      }
    };
    module2.exports = OleCompoundDoc;
  }
});

// node_modules/word-extractor/lib/filters.js
var require_filters = __commonJS({
  "node_modules/word-extractor/lib/filters.js"(exports2, module2) {
    var replaceTable = [];
    replaceTable[2] = "\0";
    replaceTable[5] = "\0";
    replaceTable[7] = "	";
    replaceTable[8] = "\0";
    replaceTable[10] = "\n";
    replaceTable[11] = "\n";
    replaceTable[12] = "\n";
    replaceTable[13] = "\n";
    replaceTable[30] = "\u2011";
    var binaryToUnicodeTable = [];
    binaryToUnicodeTable[130] = "\u201A";
    binaryToUnicodeTable[131] = "\u0192";
    binaryToUnicodeTable[132] = "\u201E";
    binaryToUnicodeTable[133] = "\u2026";
    binaryToUnicodeTable[134] = "\u2020";
    binaryToUnicodeTable[135] = "\u2021";
    binaryToUnicodeTable[136] = "\u02C6";
    binaryToUnicodeTable[137] = "\u2030";
    binaryToUnicodeTable[138] = "\u0160";
    binaryToUnicodeTable[139] = "\u2039";
    binaryToUnicodeTable[140] = "\u0152";
    binaryToUnicodeTable[142] = "\u017D";
    binaryToUnicodeTable[145] = "\u2018";
    binaryToUnicodeTable[146] = "\u2019";
    binaryToUnicodeTable[147] = "\u201C";
    binaryToUnicodeTable[148] = "\u201D";
    binaryToUnicodeTable[149] = "\u2022";
    binaryToUnicodeTable[150] = "\u2013";
    binaryToUnicodeTable[151] = "\u2014";
    binaryToUnicodeTable[152] = "\u02DC";
    binaryToUnicodeTable[153] = "\u2122";
    binaryToUnicodeTable[154] = "\u0161";
    binaryToUnicodeTable[155] = "\u203A";
    binaryToUnicodeTable[156] = "\u0153";
    binaryToUnicodeTable[158] = "\u017E";
    binaryToUnicodeTable[159] = "\u0178";
    module2.exports.binaryToUnicode = (string) => {
      return string.replace(/([\x80-\x9f])/g, (match) => binaryToUnicodeTable[match.charCodeAt(0)]);
    };
    module2.exports.clean = (string) => {
      string = string.replace(/([\x02\x05\x07\x08\x0a\x0b\x0c\x0d\x1f])/g, (match) => replaceTable[match.charCodeAt(0)]);
      let called = true;
      while (called) {
        called = false;
        string = string.replace(/(?:\x13[^\x13\x14\x15]*\x14?([^\x13\x14\x15]*)\x15)/g, (match, p1) => {
          called = true;
          return p1;
        });
      }
      return string.replace(/[\x00-\x07]/g, "");
    };
    var filterTable = [];
    filterTable[8194] = " ";
    filterTable[8195] = " ";
    filterTable[8210] = "-";
    filterTable[8211] = "-";
    filterTable[8212] = "-";
    filterTable[8216] = "'";
    filterTable[8217] = "'";
    filterTable[8220] = '"';
    filterTable[8221] = '"';
    module2.exports.filter = (string) => {
      return string.replace(/[\u2002\u2003\u2012\u2013\u2014\u2018\u2019\u201c\u201d]/g, (match) => filterTable[match.charCodeAt(0)]);
    };
  }
});

// node_modules/word-extractor/lib/document.js
var require_document = __commonJS({
  "node_modules/word-extractor/lib/document.js"(exports2, module2) {
    var { filter } = require_filters();
    var Document = class {
      constructor() {
        this._body = "";
        this._footnotes = "";
        this._endnotes = "";
        this._headers = "";
        this._footers = "";
        this._annotations = "";
        this._textboxes = "";
        this._headerTextboxes = "";
      }
      /**
       * Accessor to read the main body part of a Word file
       * @param {Object} options - options for body data
       * @param {boolean} options.filterUnicode - if true (the default), converts common Unicode quotes
       *   to standard ASCII characters 
       * @returns a string, containing the Word file body
       */
      getBody(options) {
        options = options || {};
        const value = this._body;
        return options.filterUnicode == false ? value : filter(value);
      }
      /**
       * Accessor to read the footnotes part of a Word file
       * @param {Object} options - options for body data
       * @param {boolean} options.filterUnicode - if true (the default), converts common Unicode quotes
       *   to standard ASCII characters 
       * @returns a string, containing the Word file footnotes
       */
      getFootnotes(options) {
        options = options || {};
        const value = this._footnotes;
        return options.filterUnicode == false ? value : filter(value);
      }
      /**
       * Accessor to read the endnotes part of a Word file
       * @param {Object} options - options for body data
       * @param {boolean} options.filterUnicode - if true (the default), converts common Unicode quotes
       *   to standard ASCII characters 
       * @returns a string, containing the Word file endnotes
       */
      getEndnotes(options) {
        options = options || {};
        const value = this._endnotes;
        return options.filterUnicode == false ? value : filter(value);
      }
      /**
       * Accessor to read the headers part of a Word file
       * @param {Object} options - options for body data
       * @param {boolean} options.filterUnicode - if true (the default), converts common Unicode quotes
       *   to standard ASCII characters 
       * @param {boolean} options.includeFooters - if true (the default), returns headers and footers 
       *   as a single string
       * @returns a string, containing the Word file headers
       */
      getHeaders(options) {
        options = options || {};
        const value = this._headers + (options.includeFooters == false ? "" : this._footers);
        return options.filterUnicode == false ? value : filter(value);
      }
      /**
       * Accessor to read the footers part of a Word file
       * @param {Object} options - options for body data
       * @param {boolean} options.filterUnicode - if true (the default), converts common Unicode quotes
       *   to standard ASCII characters 
       * @returns a string, containing the Word file footers
       */
      getFooters(options) {
        options = options || {};
        const value = this._footers;
        return options.filterUnicode == false ? value : filter(value);
      }
      /**
       * Accessor to read the annotations part of a Word file
       * @param {Object} options - options for body data
       * @param {boolean} options.filterUnicode - if true (the default), converts common Unicode quotes
       *   to standard ASCII characters 
       * @returns a string, containing the Word file annotations
       */
      getAnnotations(options) {
        options = options || {};
        const value = this._annotations;
        return options.filterUnicode == false ? value : filter(value);
      }
      /**
       * Accessor to read the textboxes from a Word file. The text box content is aggregated as a 
       * single long string. When both the body and header content exists, they will be separated
       * by a newline.
       * @param {Object} options - options for body data
       * @param {boolean} options.filterUnicode - if true (the default), converts common Unicode quotes
       *   to standard ASCII characters 
       * @param {boolean} options.includeHeadersAndFooters - if true (the default), includes text box
       *   content in headers and footers
       * @param {boolean} options.includeBody - if true (the default), includes text box
       *   content in the document body
       * @returns a string, containing the Word file text box content
       */
      getTextboxes(options) {
        options = options || {};
        const segments = [];
        if (options.includeBody != false)
          segments.push(this._textboxes);
        if (options.includeHeadersAndFooters != false)
          segments.push(this._headerTextboxes);
        const value = segments.join("\n");
        return options.filterUnicode == false ? value : filter(value);
      }
    };
    module2.exports = Document;
  }
});

// node_modules/word-extractor/lib/word-ole-extractor.js
var require_word_ole_extractor = __commonJS({
  "node_modules/word-extractor/lib/word-ole-extractor.js"(exports2, module2) {
    var OleCompoundDoc = require_ole_compound_doc();
    var Document = require_document();
    var { binaryToUnicode, clean } = require_filters();
    var sprmCFRMarkDel = 0;
    var getPieceIndexByCP = (pieces, position) => {
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i];
        if (position <= piece.endCp) {
          return i;
        }
      }
    };
    var getPieceIndexByFilePos = (pieces, position) => {
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i];
        if (position <= piece.endFilePos) {
          return i;
        }
      }
    };
    function getTextRangeByCP(pieces, start, end) {
      const startPiece = getPieceIndexByCP(pieces, start);
      const endPiece = getPieceIndexByCP(pieces, end);
      const result = [];
      for (let i = startPiece, end1 = endPiece; i <= end1; i++) {
        const piece = pieces[i];
        const xstart = i === startPiece ? start - piece.startCp : 0;
        const xend = i === endPiece ? end - piece.startCp : piece.endCp;
        result.push(piece.text.substring(xstart, xend));
      }
      return result.join("");
    }
    function fillPieceRange(piece, start, end, character) {
      const pieceStart = piece.startCp;
      const pieceEnd = pieceStart + piece.length;
      const original = piece.text;
      if (start < pieceStart) start = pieceStart;
      if (end > pieceEnd) end = pieceEnd;
      const modified = (start == pieceStart ? "" : original.slice(0, start - pieceStart)) + "".padStart(end - start, character) + (end == pieceEnd ? "" : original.slice(end - pieceEnd));
      piece.text = modified;
    }
    function fillPieceRangeByFilePos(piece, start, end, character) {
      const pieceStart = piece.startFilePos;
      const pieceEnd = pieceStart + piece.size;
      const original = piece.text;
      if (start < pieceStart) start = pieceStart;
      if (end > pieceEnd) end = pieceEnd;
      const modified = (start == pieceStart ? "" : original.slice(0, (start - pieceStart) / piece.bpc)) + "".padStart((end - start) / piece.bpc, character) + (end == pieceEnd ? "" : original.slice((end - pieceEnd) / piece.bpc));
      piece.text = modified;
    }
    function replaceSelectedRange(pieces, start, end, character) {
      const startPiece = getPieceIndexByCP(pieces, start);
      const endPiece = getPieceIndexByCP(pieces, end);
      for (let i = startPiece, end1 = endPiece; i <= end1; i++) {
        const piece = pieces[i];
        fillPieceRange(piece, start, end, character);
      }
    }
    function replaceSelectedRangeByFilePos(pieces, start, end, character) {
      const startPiece = getPieceIndexByFilePos(pieces, start);
      const endPiece = getPieceIndexByFilePos(pieces, end);
      for (let i = startPiece, end1 = endPiece; i <= end1; i++) {
        const piece = pieces[i];
        fillPieceRangeByFilePos(piece, start, end, character);
      }
    }
    function markDeletedRange(pieces, start, end) {
      replaceSelectedRangeByFilePos(pieces, start, end, "\0");
    }
    var processSprms = (buffer, offset, handler) => {
      while (offset < buffer.length - 1) {
        const sprm = buffer.readUInt16LE(offset);
        const ispmd = sprm & 31;
        const fspec = sprm >> 9 & 1;
        const sgc = sprm >> 10 & 7;
        const spra = sprm >> 13 & 7;
        offset += 2;
        handler(buffer, offset, sprm, ispmd, fspec, sgc, spra);
        if (spra === 0) {
          offset += 1;
          continue;
        } else if (spra === 1) {
          offset += 1;
          continue;
        } else if (spra === 2) {
          offset += 2;
          continue;
        } else if (spra === 3) {
          offset += 4;
          continue;
        } else if (spra === 4 || spra === 5) {
          offset += 2;
          continue;
        } else if (spra === 6) {
          offset += buffer.readUInt8(offset) + 1;
          continue;
        } else if (spra === 7) {
          offset += 3;
          continue;
        } else {
          throw new Error("Unparsed sprm");
        }
      }
    };
    var WordOleExtractor = class {
      constructor() {
        this._pieces = [];
        this._bookmarks = {};
        this._boundaries = {};
        this._taggedHeaders = [];
      }
      /**
       * The main extraction method. This creates an OLE compound document
       * interface, then opens up a stream and extracts out the main
       * stream.
       * @param {*} reader 
       */
      extract(reader) {
        const document = new OleCompoundDoc(reader);
        return document.read().then(
          () => this.documentStream(document, "WordDocument").then((stream) => this.streamBuffer(stream)).then((buffer) => this.extractWordDocument(document, buffer))
        );
      }
      /**
       * Builds and returns a {@link Document} object corresponding to the text
       * in the original document. This involves reading and retrieving the text
       * ranges corresponding to the primary document parts. The text segments are
       * read from the extracted table of text pieces.
       * @returns a {@link Document} object
       */
      buildDocument() {
        const document = new Document();
        const pieces = this._pieces;
        let start = 0;
        document._body = clean(getTextRangeByCP(pieces, start, start + this._boundaries.ccpText));
        start += this._boundaries.ccpText;
        if (this._boundaries.ccpFtn) {
          document._footnotes = clean(getTextRangeByCP(pieces, start, start + this._boundaries.ccpFtn - 1));
          start += this._boundaries.ccpFtn;
        }
        if (this._boundaries.ccpHdd) {
          document._headers = clean(this._taggedHeaders.filter((s) => s.type === "headers").map((s) => s.text).join(""));
          document._footers = clean(this._taggedHeaders.filter((s) => s.type === "footers").map((s) => s.text).join(""));
          start += this._boundaries.ccpHdd;
        }
        if (this._boundaries.ccpAtn) {
          document._annotations = clean(getTextRangeByCP(pieces, start, start + this._boundaries.ccpAtn - 1));
          start += this._boundaries.ccpAtn;
        }
        if (this._boundaries.ccpEdn) {
          document._endnotes = clean(getTextRangeByCP(pieces, start, start + this._boundaries.ccpEdn - 1));
          start += this._boundaries.ccpEdn;
        }
        if (this._boundaries.ccpTxbx) {
          document._textboxes = clean(getTextRangeByCP(pieces, start, start + this._boundaries.ccpTxbx - 1));
          start += this._boundaries.ccpTxbx;
        }
        if (this._boundaries.ccpHdrTxbx) {
          document._headerTextboxes = clean(getTextRangeByCP(pieces, start, start + this._boundaries.ccpHdrTxbx - 1));
          start += this._boundaries.ccpHdrTxbx;
        }
        return document;
      }
      /**
       * Main logic top level function for unpacking a Word document 
       * @param {*} document the OLE document
       * @param {*} buffer a buffer 
       * @returns a Promise which resolves to a {@link Document}
       */
      extractWordDocument(document, buffer) {
        const magic = buffer.readUInt16LE(0);
        if (magic !== 42476) {
          return Promise.reject(new Error(`This does not seem to be a Word document: Invalid magic number: ${magic.toString(16)}`));
        }
        const flags = buffer.readUInt16LE(10);
        const streamName = (flags & 512) !== 0 ? "1Table" : "0Table";
        return this.documentStream(document, streamName).then((stream) => this.streamBuffer(stream)).then((streamBuffer) => {
          this._boundaries.fcMin = buffer.readUInt32LE(24);
          this._boundaries.ccpText = buffer.readUInt32LE(76);
          this._boundaries.ccpFtn = buffer.readUInt32LE(80);
          this._boundaries.ccpHdd = buffer.readUInt32LE(84);
          this._boundaries.ccpAtn = buffer.readUInt32LE(92);
          this._boundaries.ccpEdn = buffer.readUInt32LE(96);
          this._boundaries.ccpTxbx = buffer.readUInt32LE(100);
          this._boundaries.ccpHdrTxbx = buffer.readUInt32LE(104);
          this.writeBookmarks(buffer, streamBuffer);
          this.writePieces(buffer, streamBuffer);
          this.writeCharacterProperties(buffer, streamBuffer);
          this.writeParagraphProperties(buffer, streamBuffer);
          this.normalizeHeaders(buffer, streamBuffer);
          return this.buildDocument();
        });
      }
      /**
       * Returns a promise that resolves to the named stream.
       * @param {*} document 
       * @param {*} streamName 
       * @returns a promise that resolves to the named stream
       */
      documentStream(document, streamName) {
        return Promise.resolve(document.stream(streamName));
      }
      /**
       * Returns a promise that resolves to a Buffer containing the contents of 
       * the given stream. 
       * @param {*} stream 
       * @returns a promise that resolves to the sream contents
       */
      streamBuffer(stream) {
        return new Promise((resolve, reject) => {
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("error", (error) => reject(error));
          stream.on("end", () => resolve(Buffer.concat(chunks)));
          return stream;
        });
      }
      writeFields(buffer, tableBuffer, result) {
        const fcPlcffldMom = buffer.readInt32LE(282);
        const lcbPlcffldMom = buffer.readUInt32LE(286);
        if (lcbPlcffldMom == 0) {
          return;
        }
        const fieldCount = (lcbPlcffldMom - 4) / 6;
        const dataOffset = (fieldCount + 1) * 4;
        const plcffldMom = tableBuffer.slice(fcPlcffldMom, fcPlcffldMom + lcbPlcffldMom);
        for (let i = 0; i < fieldCount; i++) {
          const cp = plcffldMom.readUInt32LE(i * 4);
          const fld = plcffldMom.readUInt16LE(dataOffset + i * 2);
          const byte1 = fld & 255;
          const byte2 = fld >> 8;
          if ((byte1 & 31) == 19) {
          } else {
          }
        }
      }
      /**
       * Extracts and stores the document bookmarks into a local field.
       * @param {*} buffer 
       * @param {*} tableBuffer 
       */
      writeBookmarks(buffer, tableBuffer) {
        const fcSttbfBkmk = buffer.readUInt32LE(322);
        const lcbSttbfBkmk = buffer.readUInt32LE(326);
        const fcPlcfBkf = buffer.readUInt32LE(330);
        const lcbPlcfBkf = buffer.readUInt32LE(334);
        const fcPlcfBkl = buffer.readUInt32LE(338);
        const lcbPlcfBkl = buffer.readUInt32LE(342);
        if (lcbSttbfBkmk === 0) {
          return;
        }
        const sttbfBkmk = tableBuffer.slice(fcSttbfBkmk, fcSttbfBkmk + lcbSttbfBkmk);
        const plcfBkf = tableBuffer.slice(fcPlcfBkf, fcPlcfBkf + lcbPlcfBkf);
        const plcfBkl = tableBuffer.slice(fcPlcfBkl, fcPlcfBkl + lcbPlcfBkl);
        const fcExtend = sttbfBkmk.readUInt16LE(0);
        const cData = sttbfBkmk.readUInt16LE(2);
        const cbExtra = sttbfBkmk.readUInt16LE(4);
        if (fcExtend !== 65535) {
          throw new Error("Internal error: unexpected single-byte bookmark data");
        }
        let offset = 6;
        const index = 0;
        while (offset < lcbSttbfBkmk) {
          let length = sttbfBkmk.readUInt16LE(offset);
          length = length * 2;
          const segment = sttbfBkmk.slice(offset + 2, offset + 2 + length);
          const cpStart = plcfBkf.readUInt32LE(index * 4);
          const cpEnd = plcfBkl.readUInt32LE(index * 4);
          this._bookmarks[segment] = { start: cpStart, end: cpEnd };
          offset = offset + length + 2;
        }
      }
      /**
       * Extracts and stores the document text pieces into a local field. This is
       * probably the most crucial part of text extraction, as it is where we
       * get text corresponding to character positions. These may be stored in a 
       * different order in the file compared to the order we want them. 
       * 
       * @param {*} buffer 
       * @param {*} tableBuffer 
       */
      writePieces(buffer, tableBuffer) {
        let flag;
        let pos = buffer.readUInt32LE(418);
        while (true) {
          flag = tableBuffer.readUInt8(pos);
          if (flag !== 1) {
            break;
          }
          pos = pos + 1;
          const skip = tableBuffer.readUInt16LE(pos);
          pos = pos + 2 + skip;
        }
        flag = tableBuffer.readUInt8(pos);
        pos = pos + 1;
        if (flag !== 2) {
          throw new Error("Internal error: ccorrupted Word file");
        }
        const pieceTableSize = tableBuffer.readUInt32LE(pos);
        pos = pos + 4;
        const pieces = (pieceTableSize - 4) / 12;
        let startCp = 0;
        let startStream = 0;
        for (let x = 0, end = pieces - 1; x <= end; x++) {
          const offset = pos + (pieces + 1) * 4 + x * 8 + 2;
          let startFilePos = tableBuffer.readUInt32LE(offset);
          let unicode = false;
          if ((startFilePos & 1073741824) === 0) {
            unicode = true;
          } else {
            startFilePos = startFilePos & ~1073741824;
            startFilePos = Math.floor(startFilePos / 2);
          }
          const lStart = tableBuffer.readUInt32LE(pos + x * 4);
          const lEnd = tableBuffer.readUInt32LE(pos + (x + 1) * 4);
          const totLength = lEnd - lStart;
          const piece = {
            startCp,
            startStream,
            totLength,
            startFilePos,
            unicode,
            bpc: unicode ? 2 : 1
          };
          piece.size = piece.bpc * (lEnd - lStart);
          const textBuffer = buffer.slice(startFilePos, startFilePos + piece.size);
          if (unicode) {
            piece.text = textBuffer.toString("ucs2");
          } else {
            piece.text = binaryToUnicode(textBuffer.toString("binary"));
          }
          piece.length = piece.text.length;
          piece.endCp = piece.startCp + piece.length;
          piece.endStream = piece.startStream + piece.size;
          piece.endFilePos = piece.startFilePos + piece.size;
          startCp = piece.endCp;
          startStream = piece.endStream;
          this._pieces.push(piece);
        }
      }
      /**
       * Processes the headers and footers. The main logic here is that we might have a mix 
       * of "real" and "pseudo" headers. For example, a footnote generates some footnote
       * separator footer elements, which, unless they contain something interesting, we 
       * can dispense with. In fact, we want to dispense with anything which is made up of
       * whitespace and control characters, in general. This means locating the segments of
       * text in the extracted pieces, and conditionally replacing them with nulls. 
       * 
       * @param {*} buffer 
       * @param {*} tableBuffer 
       */
      normalizeHeaders(buffer, tableBuffer) {
        const pieces = this._pieces;
        const fcPlcfhdd = buffer.readUInt32LE(242);
        const lcbPlcfhdd = buffer.readUInt32LE(246);
        if (lcbPlcfhdd < 8) {
          return;
        }
        const offset = this._boundaries.ccpText + this._boundaries.ccpFtn;
        const ccpHdd = this._boundaries.ccpHdd;
        const plcHdd = tableBuffer.slice(fcPlcfhdd, fcPlcfhdd + lcbPlcfhdd);
        const plcHddCount = lcbPlcfhdd / 4;
        let start = offset + plcHdd.readUInt32LE(0);
        for (let i = 1; i < plcHddCount; i++) {
          let end = offset + plcHdd.readUInt32LE(i * 4);
          if (end > offset + ccpHdd) {
            end = offset + ccpHdd;
          }
          const string = getTextRangeByCP(pieces, start, end);
          const story = i - 1;
          if ([0, 1, 2].includes(story)) {
            this._taggedHeaders.push({ type: "footnoteSeparators", text: string });
          } else if ([3, 4, 5].includes(story)) {
            this._taggedHeaders.push({ type: "endSeparators", text: string });
          } else if ([0, 1, 4].includes(story % 6)) {
            this._taggedHeaders.push({ type: "headers", text: string });
          } else if ([2, 3, 5].includes(story % 6)) {
            this._taggedHeaders.push({ type: "footers", text: string });
          }
          if (!/[^\r\n\u0002-\u0008]/.test(string)) {
            replaceSelectedRange(pieces, start, end, "\0");
          } else {
            replaceSelectedRange(pieces, end - 1, end, "\0");
          }
          start = end;
        }
      }
      writeParagraphProperties(buffer, tableBuffer) {
        const pieces = this._pieces;
        const fcPlcfbtePapx = buffer.readUInt32LE(258);
        const lcbPlcfbtePapx = buffer.readUInt32LE(262);
        const plcBtePapxCount = (lcbPlcfbtePapx - 4) / 8;
        const dataOffset = (plcBtePapxCount + 1) * 4;
        const plcBtePapx = tableBuffer.slice(fcPlcfbtePapx, fcPlcfbtePapx + lcbPlcfbtePapx);
        for (let i = 0; i < plcBtePapxCount; i++) {
          const cp = plcBtePapx.readUInt32LE(i * 4);
          const papxFkpBlock = plcBtePapx.readUInt32LE(dataOffset + i * 4);
          const papxFkpBlockBuffer = buffer.slice(papxFkpBlock * 512, (papxFkpBlock + 1) * 512);
          const crun = papxFkpBlockBuffer.readUInt8(511);
          for (let j = 0; j < crun; j++) {
            const rgfc = papxFkpBlockBuffer.readUInt32LE(j * 4);
            const rgfcNext = papxFkpBlockBuffer.readUInt32LE((j + 1) * 4);
            const cbLocation = (crun + 1) * 4 + j * 13;
            const cbIndex = papxFkpBlockBuffer.readUInt8(cbLocation) * 2;
            const cb = papxFkpBlockBuffer.readUInt8(cbIndex);
            let grpPrlAndIstd = null;
            if (cb !== 0) {
              grpPrlAndIstd = papxFkpBlockBuffer.slice(cbIndex + 1, cbIndex + 1 + 2 * cb - 1);
            } else {
              const cb2 = papxFkpBlockBuffer.readUInt8(cbIndex + 1);
              grpPrlAndIstd = papxFkpBlockBuffer.slice(cbIndex + 2, cbIndex + 2 + 2 * cb2);
            }
            const istd = grpPrlAndIstd.readUInt16LE(0);
            processSprms(grpPrlAndIstd, 2, (buffer2, offset, sprm, ispmd, fspec, sgc, spra) => {
              if (sprm === 9239) {
                replaceSelectedRangeByFilePos(pieces, rgfc, rgfcNext, "\n");
              }
            });
          }
        }
      }
      writeCharacterProperties(buffer, tableBuffer) {
        const pieces = this._pieces;
        const fcPlcfbteChpx = buffer.readUInt32LE(250);
        const lcbPlcfbteChpx = buffer.readUInt32LE(254);
        const plcBteChpxCount = (lcbPlcfbteChpx - 4) / 8;
        const dataOffset = (plcBteChpxCount + 1) * 4;
        const plcBteChpx = tableBuffer.slice(fcPlcfbteChpx, fcPlcfbteChpx + lcbPlcfbteChpx);
        let lastDeletionEnd = null;
        for (let i = 0; i < plcBteChpxCount; i++) {
          const cp = plcBteChpx.readUInt32LE(i * 4);
          const chpxFkpBlock = plcBteChpx.readUInt32LE(dataOffset + i * 4);
          const chpxFkpBlockBuffer = buffer.slice(chpxFkpBlock * 512, (chpxFkpBlock + 1) * 512);
          const crun = chpxFkpBlockBuffer.readUInt8(511);
          for (let j = 0; j < crun; j++) {
            const rgfc = chpxFkpBlockBuffer.readUInt32LE(j * 4);
            const rgfcNext = chpxFkpBlockBuffer.readUInt32LE((j + 1) * 4);
            const rgb = chpxFkpBlockBuffer.readUInt8((crun + 1) * 4 + j);
            if (rgb == 0) {
              continue;
            }
            const chpxOffset = rgb * 2;
            const cb = chpxFkpBlockBuffer.readUInt8(chpxOffset);
            const grpprl = chpxFkpBlockBuffer.slice(chpxOffset + 1, chpxOffset + 1 + cb);
            processSprms(grpprl, 0, (buffer2, offset, sprm, ispmd) => {
              if (ispmd === sprmCFRMarkDel) {
                if ((buffer2[offset] & 1) != 1) {
                  return;
                }
                if (lastDeletionEnd === rgfc) {
                  markDeletedRange(pieces, lastDeletionEnd, rgfcNext);
                } else {
                  markDeletedRange(pieces, rgfc, rgfcNext);
                }
                lastDeletionEnd = rgfcNext;
              }
            });
          }
        }
      }
    };
    module2.exports = WordOleExtractor;
  }
});

// node_modules/xmlchars/xml/1.0/ed5.js
var require_ed5 = __commonJS({
  "node_modules/xmlchars/xml/1.0/ed5.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.CHAR = "	\n\r -\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}";
    exports2.S = " 	\r\n";
    exports2.NAME_START_CHAR = ":A-Z_a-z\xC0-\xD6\xD8-\xF6\xF8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}";
    exports2.NAME_CHAR = "-" + exports2.NAME_START_CHAR + ".0-9\xB7\u0300-\u036F\u203F-\u2040";
    exports2.CHAR_RE = new RegExp("^[" + exports2.CHAR + "]$", "u");
    exports2.S_RE = new RegExp("^[" + exports2.S + "]+$", "u");
    exports2.NAME_START_CHAR_RE = new RegExp("^[" + exports2.NAME_START_CHAR + "]$", "u");
    exports2.NAME_CHAR_RE = new RegExp("^[" + exports2.NAME_CHAR + "]$", "u");
    exports2.NAME_RE = new RegExp("^[" + exports2.NAME_START_CHAR + "][" + exports2.NAME_CHAR + "]*$", "u");
    exports2.NMTOKEN_RE = new RegExp("^[" + exports2.NAME_CHAR + "]+$", "u");
    var TAB = 9;
    var NL = 10;
    var CR = 13;
    var SPACE = 32;
    exports2.S_LIST = [SPACE, NL, CR, TAB];
    function isChar(c) {
      return c >= SPACE && c <= 55295 || c === NL || c === CR || c === TAB || c >= 57344 && c <= 65533 || c >= 65536 && c <= 1114111;
    }
    exports2.isChar = isChar;
    function isS(c) {
      return c === SPACE || c === NL || c === CR || c === TAB;
    }
    exports2.isS = isS;
    function isNameStartChar(c) {
      return c >= 65 && c <= 90 || c >= 97 && c <= 122 || c === 58 || c === 95 || c === 8204 || c === 8205 || c >= 192 && c <= 214 || c >= 216 && c <= 246 || c >= 248 && c <= 767 || c >= 880 && c <= 893 || c >= 895 && c <= 8191 || c >= 8304 && c <= 8591 || c >= 11264 && c <= 12271 || c >= 12289 && c <= 55295 || c >= 63744 && c <= 64975 || c >= 65008 && c <= 65533 || c >= 65536 && c <= 983039;
    }
    exports2.isNameStartChar = isNameStartChar;
    function isNameChar(c) {
      return isNameStartChar(c) || c >= 48 && c <= 57 || c === 45 || c === 46 || c === 183 || c >= 768 && c <= 879 || c >= 8255 && c <= 8256;
    }
    exports2.isNameChar = isNameChar;
  }
});

// node_modules/xmlchars/xml/1.1/ed2.js
var require_ed2 = __commonJS({
  "node_modules/xmlchars/xml/1.1/ed2.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.CHAR = "-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}";
    exports2.RESTRICTED_CHAR = "-\b\v\f-\x7F-\x84\x86-\x9F";
    exports2.S = " 	\r\n";
    exports2.NAME_START_CHAR = ":A-Z_a-z\xC0-\xD6\xD8-\xF6\xF8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}";
    exports2.NAME_CHAR = "-" + exports2.NAME_START_CHAR + ".0-9\xB7\u0300-\u036F\u203F-\u2040";
    exports2.CHAR_RE = new RegExp("^[" + exports2.CHAR + "]$", "u");
    exports2.RESTRICTED_CHAR_RE = new RegExp("^[" + exports2.RESTRICTED_CHAR + "]$", "u");
    exports2.S_RE = new RegExp("^[" + exports2.S + "]+$", "u");
    exports2.NAME_START_CHAR_RE = new RegExp("^[" + exports2.NAME_START_CHAR + "]$", "u");
    exports2.NAME_CHAR_RE = new RegExp("^[" + exports2.NAME_CHAR + "]$", "u");
    exports2.NAME_RE = new RegExp("^[" + exports2.NAME_START_CHAR + "][" + exports2.NAME_CHAR + "]*$", "u");
    exports2.NMTOKEN_RE = new RegExp("^[" + exports2.NAME_CHAR + "]+$", "u");
    var TAB = 9;
    var NL = 10;
    var CR = 13;
    var SPACE = 32;
    exports2.S_LIST = [SPACE, NL, CR, TAB];
    function isChar(c) {
      return c >= 1 && c <= 55295 || c >= 57344 && c <= 65533 || c >= 65536 && c <= 1114111;
    }
    exports2.isChar = isChar;
    function isRestrictedChar(c) {
      return c >= 1 && c <= 8 || c === 11 || c === 12 || c >= 14 && c <= 31 || c >= 127 && c <= 132 || c >= 134 && c <= 159;
    }
    exports2.isRestrictedChar = isRestrictedChar;
    function isCharAndNotRestricted(c) {
      return c === 9 || c === 10 || c === 13 || c > 31 && c < 127 || c === 133 || c > 159 && c <= 55295 || c >= 57344 && c <= 65533 || c >= 65536 && c <= 1114111;
    }
    exports2.isCharAndNotRestricted = isCharAndNotRestricted;
    function isS(c) {
      return c === SPACE || c === NL || c === CR || c === TAB;
    }
    exports2.isS = isS;
    function isNameStartChar(c) {
      return c >= 65 && c <= 90 || c >= 97 && c <= 122 || c === 58 || c === 95 || c === 8204 || c === 8205 || c >= 192 && c <= 214 || c >= 216 && c <= 246 || c >= 248 && c <= 767 || c >= 880 && c <= 893 || c >= 895 && c <= 8191 || c >= 8304 && c <= 8591 || c >= 11264 && c <= 12271 || c >= 12289 && c <= 55295 || c >= 63744 && c <= 64975 || c >= 65008 && c <= 65533 || c >= 65536 && c <= 983039;
    }
    exports2.isNameStartChar = isNameStartChar;
    function isNameChar(c) {
      return isNameStartChar(c) || c >= 48 && c <= 57 || c === 45 || c === 46 || c === 183 || c >= 768 && c <= 879 || c >= 8255 && c <= 8256;
    }
    exports2.isNameChar = isNameChar;
  }
});

// node_modules/xmlchars/xmlns/1.0/ed3.js
var require_ed3 = __commonJS({
  "node_modules/xmlchars/xmlns/1.0/ed3.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.NC_NAME_START_CHAR = "A-Z_a-z\xC0-\xD6\xD8-\xF6\xF8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}";
    exports2.NC_NAME_CHAR = "-" + exports2.NC_NAME_START_CHAR + ".0-9\xB7\u0300-\u036F\u203F-\u2040";
    exports2.NC_NAME_START_CHAR_RE = new RegExp("^[" + exports2.NC_NAME_START_CHAR + "]$", "u");
    exports2.NC_NAME_CHAR_RE = new RegExp("^[" + exports2.NC_NAME_CHAR + "]$", "u");
    exports2.NC_NAME_RE = new RegExp("^[" + exports2.NC_NAME_START_CHAR + "][" + exports2.NC_NAME_CHAR + "]*$", "u");
    function isNCNameStartChar(c) {
      return c >= 65 && c <= 90 || c === 95 || c >= 97 && c <= 122 || c >= 192 && c <= 214 || c >= 216 && c <= 246 || c >= 248 && c <= 767 || c >= 880 && c <= 893 || c >= 895 && c <= 8191 || c >= 8204 && c <= 8205 || c >= 8304 && c <= 8591 || c >= 11264 && c <= 12271 || c >= 12289 && c <= 55295 || c >= 63744 && c <= 64975 || c >= 65008 && c <= 65533 || c >= 65536 && c <= 983039;
    }
    exports2.isNCNameStartChar = isNCNameStartChar;
    function isNCNameChar(c) {
      return isNCNameStartChar(c) || (c === 45 || c === 46 || c >= 48 && c <= 57 || c === 183 || c >= 768 && c <= 879 || c >= 8255 && c <= 8256);
    }
    exports2.isNCNameChar = isNCNameChar;
  }
});

// node_modules/saxes/saxes.js
var require_saxes = __commonJS({
  "node_modules/saxes/saxes.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var ed5 = require_ed5();
    var ed2 = require_ed2();
    var NSed3 = require_ed3();
    var isS = ed5.isS;
    var isChar10 = ed5.isChar;
    var isNameStartChar = ed5.isNameStartChar;
    var isNameChar = ed5.isNameChar;
    var S_LIST = ed5.S_LIST;
    var NAME_RE = ed5.NAME_RE;
    var isChar11 = ed2.isChar;
    var isNCNameStartChar = NSed3.isNCNameStartChar;
    var isNCNameChar = NSed3.isNCNameChar;
    var NC_NAME_RE = NSed3.NC_NAME_RE;
    var XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
    var XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
    var rootNS = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      __proto__: null,
      xml: XML_NAMESPACE,
      xmlns: XMLNS_NAMESPACE
    };
    var XML_ENTITIES = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      __proto__: null,
      amp: "&",
      gt: ">",
      lt: "<",
      quot: '"',
      apos: "'"
    };
    var EOC = -1;
    var NL_LIKE = -2;
    var S_BEGIN = 0;
    var S_BEGIN_WHITESPACE = 1;
    var S_DOCTYPE = 2;
    var S_DOCTYPE_QUOTE = 3;
    var S_DTD = 4;
    var S_DTD_QUOTED = 5;
    var S_DTD_OPEN_WAKA = 6;
    var S_DTD_OPEN_WAKA_BANG = 7;
    var S_DTD_COMMENT = 8;
    var S_DTD_COMMENT_ENDING = 9;
    var S_DTD_COMMENT_ENDED = 10;
    var S_DTD_PI = 11;
    var S_DTD_PI_ENDING = 12;
    var S_TEXT = 13;
    var S_ENTITY = 14;
    var S_OPEN_WAKA = 15;
    var S_OPEN_WAKA_BANG = 16;
    var S_COMMENT = 17;
    var S_COMMENT_ENDING = 18;
    var S_COMMENT_ENDED = 19;
    var S_CDATA = 20;
    var S_CDATA_ENDING = 21;
    var S_CDATA_ENDING_2 = 22;
    var S_PI_FIRST_CHAR = 23;
    var S_PI_REST = 24;
    var S_PI_BODY = 25;
    var S_PI_ENDING = 26;
    var S_XML_DECL_NAME_START = 27;
    var S_XML_DECL_NAME = 28;
    var S_XML_DECL_EQ = 29;
    var S_XML_DECL_VALUE_START = 30;
    var S_XML_DECL_VALUE = 31;
    var S_XML_DECL_SEPARATOR = 32;
    var S_XML_DECL_ENDING = 33;
    var S_OPEN_TAG = 34;
    var S_OPEN_TAG_SLASH = 35;
    var S_ATTRIB = 36;
    var S_ATTRIB_NAME = 37;
    var S_ATTRIB_NAME_SAW_WHITE = 38;
    var S_ATTRIB_VALUE = 39;
    var S_ATTRIB_VALUE_QUOTED = 40;
    var S_ATTRIB_VALUE_CLOSED = 41;
    var S_ATTRIB_VALUE_UNQUOTED = 42;
    var S_CLOSE_TAG = 43;
    var S_CLOSE_TAG_SAW_WHITE = 44;
    var TAB = 9;
    var NL = 10;
    var CR = 13;
    var SPACE = 32;
    var BANG = 33;
    var DQUOTE = 34;
    var AMP = 38;
    var SQUOTE = 39;
    var MINUS = 45;
    var FORWARD_SLASH = 47;
    var SEMICOLON = 59;
    var LESS = 60;
    var EQUAL = 61;
    var GREATER = 62;
    var QUESTION = 63;
    var OPEN_BRACKET = 91;
    var CLOSE_BRACKET = 93;
    var NEL = 133;
    var LS = 8232;
    var isQuote = (c) => c === DQUOTE || c === SQUOTE;
    var QUOTES = [DQUOTE, SQUOTE];
    var DOCTYPE_TERMINATOR = [...QUOTES, OPEN_BRACKET, GREATER];
    var DTD_TERMINATOR = [...QUOTES, LESS, CLOSE_BRACKET];
    var XML_DECL_NAME_TERMINATOR = [EQUAL, QUESTION, ...S_LIST];
    var ATTRIB_VALUE_UNQUOTED_TERMINATOR = [...S_LIST, GREATER, AMP, LESS];
    function nsPairCheck(parser, prefix, uri) {
      switch (prefix) {
        case "xml":
          if (uri !== XML_NAMESPACE) {
            parser.fail(`xml prefix must be bound to ${XML_NAMESPACE}.`);
          }
          break;
        case "xmlns":
          if (uri !== XMLNS_NAMESPACE) {
            parser.fail(`xmlns prefix must be bound to ${XMLNS_NAMESPACE}.`);
          }
          break;
        default:
      }
      switch (uri) {
        case XMLNS_NAMESPACE:
          parser.fail(prefix === "" ? `the default namespace may not be set to ${uri}.` : `may not assign a prefix (even "xmlns") to the URI ${XMLNS_NAMESPACE}.`);
          break;
        case XML_NAMESPACE:
          switch (prefix) {
            case "xml":
              break;
            case "":
              parser.fail(`the default namespace may not be set to ${uri}.`);
              break;
            default:
              parser.fail("may not assign the xml namespace to another prefix.");
          }
          break;
        default:
      }
    }
    function nsMappingCheck(parser, mapping) {
      for (const local of Object.keys(mapping)) {
        nsPairCheck(parser, local, mapping[local]);
      }
    }
    var isNCName = (name) => NC_NAME_RE.test(name);
    var isName = (name) => NAME_RE.test(name);
    var FORBIDDEN_START = 0;
    var FORBIDDEN_BRACKET = 1;
    var FORBIDDEN_BRACKET_BRACKET = 2;
    exports2.EVENTS = [
      "xmldecl",
      "text",
      "processinginstruction",
      "doctype",
      "comment",
      "opentagstart",
      "attribute",
      "opentag",
      "closetag",
      "cdata",
      "error",
      "end",
      "ready"
    ];
    var EVENT_NAME_TO_HANDLER_NAME = {
      xmldecl: "xmldeclHandler",
      text: "textHandler",
      processinginstruction: "piHandler",
      doctype: "doctypeHandler",
      comment: "commentHandler",
      opentagstart: "openTagStartHandler",
      attribute: "attributeHandler",
      opentag: "openTagHandler",
      closetag: "closeTagHandler",
      cdata: "cdataHandler",
      error: "errorHandler",
      end: "endHandler",
      ready: "readyHandler"
    };
    var SaxesParser = class {
      /**
       * @param opt The parser options.
       */
      constructor(opt) {
        this.opt = opt !== null && opt !== void 0 ? opt : {};
        this.fragmentOpt = !!this.opt.fragment;
        const xmlnsOpt = this.xmlnsOpt = !!this.opt.xmlns;
        this.trackPosition = this.opt.position !== false;
        this.fileName = this.opt.fileName;
        if (xmlnsOpt) {
          this.nameStartCheck = isNCNameStartChar;
          this.nameCheck = isNCNameChar;
          this.isName = isNCName;
          this.processAttribs = this.processAttribsNS;
          this.pushAttrib = this.pushAttribNS;
          this.ns = Object.assign({ __proto__: null }, rootNS);
          const additional = this.opt.additionalNamespaces;
          if (additional != null) {
            nsMappingCheck(this, additional);
            Object.assign(this.ns, additional);
          }
        } else {
          this.nameStartCheck = isNameStartChar;
          this.nameCheck = isNameChar;
          this.isName = isName;
          this.processAttribs = this.processAttribsPlain;
          this.pushAttrib = this.pushAttribPlain;
        }
        this.stateTable = [
          /* eslint-disable @typescript-eslint/unbound-method */
          this.sBegin,
          this.sBeginWhitespace,
          this.sDoctype,
          this.sDoctypeQuote,
          this.sDTD,
          this.sDTDQuoted,
          this.sDTDOpenWaka,
          this.sDTDOpenWakaBang,
          this.sDTDComment,
          this.sDTDCommentEnding,
          this.sDTDCommentEnded,
          this.sDTDPI,
          this.sDTDPIEnding,
          this.sText,
          this.sEntity,
          this.sOpenWaka,
          this.sOpenWakaBang,
          this.sComment,
          this.sCommentEnding,
          this.sCommentEnded,
          this.sCData,
          this.sCDataEnding,
          this.sCDataEnding2,
          this.sPIFirstChar,
          this.sPIRest,
          this.sPIBody,
          this.sPIEnding,
          this.sXMLDeclNameStart,
          this.sXMLDeclName,
          this.sXMLDeclEq,
          this.sXMLDeclValueStart,
          this.sXMLDeclValue,
          this.sXMLDeclSeparator,
          this.sXMLDeclEnding,
          this.sOpenTag,
          this.sOpenTagSlash,
          this.sAttrib,
          this.sAttribName,
          this.sAttribNameSawWhite,
          this.sAttribValue,
          this.sAttribValueQuoted,
          this.sAttribValueClosed,
          this.sAttribValueUnquoted,
          this.sCloseTag,
          this.sCloseTagSawWhite
        ];
        this._init();
      }
      /**
       * Indicates whether or not the parser is closed. If ``true``, wait for
       * the ``ready`` event to write again.
       */
      get closed() {
        return this._closed;
      }
      _init() {
        var _a;
        this.openWakaBang = "";
        this.text = "";
        this.name = "";
        this.piTarget = "";
        this.entity = "";
        this.q = null;
        this.tags = [];
        this.tag = null;
        this.topNS = null;
        this.chunk = "";
        this.chunkPosition = 0;
        this.i = 0;
        this.prevI = 0;
        this.carriedFromPrevious = void 0;
        this.forbiddenState = FORBIDDEN_START;
        this.attribList = [];
        const { fragmentOpt } = this;
        this.state = fragmentOpt ? S_TEXT : S_BEGIN;
        this.reportedTextBeforeRoot = this.reportedTextAfterRoot = this.closedRoot = this.sawRoot = fragmentOpt;
        this.xmlDeclPossible = !fragmentOpt;
        this.xmlDeclExpects = ["version"];
        this.entityReturnState = void 0;
        let { defaultXMLVersion } = this.opt;
        if (defaultXMLVersion === void 0) {
          if (this.opt.forceXMLVersion === true) {
            throw new Error("forceXMLVersion set but defaultXMLVersion is not set");
          }
          defaultXMLVersion = "1.0";
        }
        this.setXMLVersion(defaultXMLVersion);
        this.positionAtNewLine = 0;
        this.doctype = false;
        this._closed = false;
        this.xmlDecl = {
          version: void 0,
          encoding: void 0,
          standalone: void 0
        };
        this.line = 1;
        this.column = 0;
        this.ENTITIES = Object.create(XML_ENTITIES);
        (_a = this.readyHandler) === null || _a === void 0 ? void 0 : _a.call(this);
      }
      /**
       * The stream position the parser is currently looking at. This field is
       * zero-based.
       *
       * This field is not based on counting Unicode characters but is to be
       * interpreted as a plain index into a JavaScript string.
       */
      get position() {
        return this.chunkPosition + this.i;
      }
      /**
       * The column number of the next character to be read by the parser.  *
       * This field is zero-based. (The first column in a line is 0.)
       *
       * This field reports the index at which the next character would be in the
       * line if the line were represented as a JavaScript string.  Note that this
       * *can* be different to a count based on the number of *Unicode characters*
       * due to how JavaScript handles astral plane characters.
       *
       * See [[column]] for a number that corresponds to a count of Unicode
       * characters.
       */
      get columnIndex() {
        return this.position - this.positionAtNewLine;
      }
      /**
       * Set an event listener on an event. The parser supports one handler per
       * event type. If you try to set an event handler over an existing handler,
       * the old handler is silently overwritten.
       *
       * @param name The event to listen to.
       *
       * @param handler The handler to set.
       */
      on(name, handler) {
        this[EVENT_NAME_TO_HANDLER_NAME[name]] = handler;
      }
      /**
       * Unset an event handler.
       *
       * @parma name The event to stop listening to.
       */
      off(name) {
        this[EVENT_NAME_TO_HANDLER_NAME[name]] = void 0;
      }
      /**
       * Make an error object. The error object will have a message that contains
       * the ``fileName`` option passed at the creation of the parser. If position
       * tracking was turned on, it will also have line and column number
       * information.
       *
       * @param message The message describing the error to report.
       *
       * @returns An error object with a properly formatted message.
       */
      makeError(message) {
        var _a;
        let msg = (_a = this.fileName) !== null && _a !== void 0 ? _a : "";
        if (this.trackPosition) {
          if (msg.length > 0) {
            msg += ":";
          }
          msg += `${this.line}:${this.column}`;
        }
        if (msg.length > 0) {
          msg += ": ";
        }
        return new Error(msg + message);
      }
      /**
       * Report a parsing error. This method is made public so that client code may
       * check for issues that are outside the scope of this project and can report
       * errors.
       *
       * @param message The error to report.
       *
       * @returns this
       */
      fail(message) {
        const err = this.makeError(message);
        const handler = this.errorHandler;
        if (handler === void 0) {
          throw err;
        } else {
          handler(err);
        }
        return this;
      }
      /**
       * Write a XML data to the parser.
       *
       * @param chunk The XML data to write.
       *
       * @returns this
       */
      write(chunk) {
        if (this.closed) {
          return this.fail("cannot write after close; assign an onready handler.");
        }
        let end = false;
        if (chunk === null) {
          end = true;
          chunk = "";
        } else if (typeof chunk === "object") {
          chunk = chunk.toString();
        }
        if (this.carriedFromPrevious !== void 0) {
          chunk = `${this.carriedFromPrevious}${chunk}`;
          this.carriedFromPrevious = void 0;
        }
        let limit = chunk.length;
        const lastCode = chunk.charCodeAt(limit - 1);
        if (!end && // A trailing CR or surrogate must be carried over to the next
        // chunk.
        (lastCode === CR || lastCode >= 55296 && lastCode <= 56319)) {
          this.carriedFromPrevious = chunk[limit - 1];
          limit--;
          chunk = chunk.slice(0, limit);
        }
        const { stateTable } = this;
        this.chunk = chunk;
        this.i = 0;
        while (this.i < limit) {
          stateTable[this.state].call(this);
        }
        this.chunkPosition += limit;
        return end ? this.end() : this;
      }
      /**
       * Close the current stream. Perform final well-formedness checks and reset
       * the parser tstate.
       *
       * @returns this
       */
      close() {
        return this.write(null);
      }
      /**
       * Get a single code point out of the current chunk. This updates the current
       * position if we do position tracking.
       *
       * This is the algorithm to use for XML 1.0.
       *
       * @returns The character read.
       */
      getCode10() {
        const { chunk, i } = this;
        this.prevI = i;
        this.i = i + 1;
        if (i >= chunk.length) {
          return EOC;
        }
        const code = chunk.charCodeAt(i);
        this.column++;
        if (code < 55296) {
          if (code >= SPACE || code === TAB) {
            return code;
          }
          switch (code) {
            case NL:
              this.line++;
              this.column = 0;
              this.positionAtNewLine = this.position;
              return NL;
            case CR:
              if (chunk.charCodeAt(i + 1) === NL) {
                this.i = i + 2;
              }
              this.line++;
              this.column = 0;
              this.positionAtNewLine = this.position;
              return NL_LIKE;
            default:
              this.fail("disallowed character.");
              return code;
          }
        }
        if (code > 56319) {
          if (!(code >= 57344 && code <= 65533)) {
            this.fail("disallowed character.");
          }
          return code;
        }
        const final = 65536 + (code - 55296) * 1024 + (chunk.charCodeAt(i + 1) - 56320);
        this.i = i + 2;
        if (final > 1114111) {
          this.fail("disallowed character.");
        }
        return final;
      }
      /**
       * Get a single code point out of the current chunk. This updates the current
       * position if we do position tracking.
       *
       * This is the algorithm to use for XML 1.1.
       *
       * @returns {number} The character read.
       */
      getCode11() {
        const { chunk, i } = this;
        this.prevI = i;
        this.i = i + 1;
        if (i >= chunk.length) {
          return EOC;
        }
        const code = chunk.charCodeAt(i);
        this.column++;
        if (code < 55296) {
          if (code > 31 && code < 127 || code > 159 && code !== LS || code === TAB) {
            return code;
          }
          switch (code) {
            case NL:
              this.line++;
              this.column = 0;
              this.positionAtNewLine = this.position;
              return NL;
            case CR: {
              const next = chunk.charCodeAt(i + 1);
              if (next === NL || next === NEL) {
                this.i = i + 2;
              }
            }
            /* yes, fall through */
            case NEL:
            // 0x85
            case LS:
              this.line++;
              this.column = 0;
              this.positionAtNewLine = this.position;
              return NL_LIKE;
            default:
              this.fail("disallowed character.");
              return code;
          }
        }
        if (code > 56319) {
          if (!(code >= 57344 && code <= 65533)) {
            this.fail("disallowed character.");
          }
          return code;
        }
        const final = 65536 + (code - 55296) * 1024 + (chunk.charCodeAt(i + 1) - 56320);
        this.i = i + 2;
        if (final > 1114111) {
          this.fail("disallowed character.");
        }
        return final;
      }
      /**
       * Like ``getCode`` but with the return value normalized so that ``NL`` is
       * returned for ``NL_LIKE``.
       */
      getCodeNorm() {
        const c = this.getCode();
        return c === NL_LIKE ? NL : c;
      }
      unget() {
        this.i = this.prevI;
        this.column--;
      }
      /**
       * Capture characters into a buffer until encountering one of a set of
       * characters.
       *
       * @param chars An array of codepoints. Encountering a character in the array
       * ends the capture. (``chars`` may safely contain ``NL``.)
       *
       * @return The character code that made the capture end, or ``EOC`` if we hit
       * the end of the chunk. The return value cannot be NL_LIKE: NL is returned
       * instead.
       */
      captureTo(chars) {
        let { i: start } = this;
        const { chunk } = this;
        while (true) {
          const c = this.getCode();
          const isNLLike = c === NL_LIKE;
          const final = isNLLike ? NL : c;
          if (final === EOC || chars.includes(final)) {
            this.text += chunk.slice(start, this.prevI);
            return final;
          }
          if (isNLLike) {
            this.text += `${chunk.slice(start, this.prevI)}
`;
            start = this.i;
          }
        }
      }
      /**
       * Capture characters into a buffer until encountering a character.
       *
       * @param char The codepoint that ends the capture. **NOTE ``char`` MAY NOT
       * CONTAIN ``NL``.** Passing ``NL`` will result in buggy behavior.
       *
       * @return ``true`` if we ran into the character. Otherwise, we ran into the
       * end of the current chunk.
       */
      captureToChar(char) {
        let { i: start } = this;
        const { chunk } = this;
        while (true) {
          let c = this.getCode();
          switch (c) {
            case NL_LIKE:
              this.text += `${chunk.slice(start, this.prevI)}
`;
              start = this.i;
              c = NL;
              break;
            case EOC:
              this.text += chunk.slice(start);
              return false;
            default:
          }
          if (c === char) {
            this.text += chunk.slice(start, this.prevI);
            return true;
          }
        }
      }
      /**
       * Capture characters that satisfy ``isNameChar`` into the ``name`` field of
       * this parser.
       *
       * @return The character code that made the test fail, or ``EOC`` if we hit
       * the end of the chunk. The return value cannot be NL_LIKE: NL is returned
       * instead.
       */
      captureNameChars() {
        const { chunk, i: start } = this;
        while (true) {
          const c = this.getCode();
          if (c === EOC) {
            this.name += chunk.slice(start);
            return EOC;
          }
          if (!isNameChar(c)) {
            this.name += chunk.slice(start, this.prevI);
            return c === NL_LIKE ? NL : c;
          }
        }
      }
      /**
       * Skip white spaces.
       *
       * @return The character that ended the skip, or ``EOC`` if we hit
       * the end of the chunk. The return value cannot be NL_LIKE: NL is returned
       * instead.
       */
      skipSpaces() {
        while (true) {
          const c = this.getCodeNorm();
          if (c === EOC || !isS(c)) {
            return c;
          }
        }
      }
      setXMLVersion(version) {
        this.currentXMLVersion = version;
        if (version === "1.0") {
          this.isChar = isChar10;
          this.getCode = this.getCode10;
        } else {
          this.isChar = isChar11;
          this.getCode = this.getCode11;
        }
      }
      // STATE ENGINE METHODS
      // This needs to be a state separate from S_BEGIN_WHITESPACE because we want
      // to be sure never to come back to this state later.
      sBegin() {
        if (this.chunk.charCodeAt(0) === 65279) {
          this.i++;
          this.column++;
        }
        this.state = S_BEGIN_WHITESPACE;
      }
      sBeginWhitespace() {
        const iBefore = this.i;
        const c = this.skipSpaces();
        if (this.prevI !== iBefore) {
          this.xmlDeclPossible = false;
        }
        switch (c) {
          case LESS:
            this.state = S_OPEN_WAKA;
            if (this.text.length !== 0) {
              throw new Error("no-empty text at start");
            }
            break;
          case EOC:
            break;
          default:
            this.unget();
            this.state = S_TEXT;
            this.xmlDeclPossible = false;
        }
      }
      sDoctype() {
        var _a;
        const c = this.captureTo(DOCTYPE_TERMINATOR);
        switch (c) {
          case GREATER: {
            (_a = this.doctypeHandler) === null || _a === void 0 ? void 0 : _a.call(this, this.text);
            this.text = "";
            this.state = S_TEXT;
            this.doctype = true;
            break;
          }
          case EOC:
            break;
          default:
            this.text += String.fromCodePoint(c);
            if (c === OPEN_BRACKET) {
              this.state = S_DTD;
            } else if (isQuote(c)) {
              this.state = S_DOCTYPE_QUOTE;
              this.q = c;
            }
        }
      }
      sDoctypeQuote() {
        const q = this.q;
        if (this.captureToChar(q)) {
          this.text += String.fromCodePoint(q);
          this.q = null;
          this.state = S_DOCTYPE;
        }
      }
      sDTD() {
        const c = this.captureTo(DTD_TERMINATOR);
        if (c === EOC) {
          return;
        }
        this.text += String.fromCodePoint(c);
        if (c === CLOSE_BRACKET) {
          this.state = S_DOCTYPE;
        } else if (c === LESS) {
          this.state = S_DTD_OPEN_WAKA;
        } else if (isQuote(c)) {
          this.state = S_DTD_QUOTED;
          this.q = c;
        }
      }
      sDTDQuoted() {
        const q = this.q;
        if (this.captureToChar(q)) {
          this.text += String.fromCodePoint(q);
          this.state = S_DTD;
          this.q = null;
        }
      }
      sDTDOpenWaka() {
        const c = this.getCodeNorm();
        this.text += String.fromCodePoint(c);
        switch (c) {
          case BANG:
            this.state = S_DTD_OPEN_WAKA_BANG;
            this.openWakaBang = "";
            break;
          case QUESTION:
            this.state = S_DTD_PI;
            break;
          default:
            this.state = S_DTD;
        }
      }
      sDTDOpenWakaBang() {
        const char = String.fromCodePoint(this.getCodeNorm());
        const owb = this.openWakaBang += char;
        this.text += char;
        if (owb !== "-") {
          this.state = owb === "--" ? S_DTD_COMMENT : S_DTD;
          this.openWakaBang = "";
        }
      }
      sDTDComment() {
        if (this.captureToChar(MINUS)) {
          this.text += "-";
          this.state = S_DTD_COMMENT_ENDING;
        }
      }
      sDTDCommentEnding() {
        const c = this.getCodeNorm();
        this.text += String.fromCodePoint(c);
        this.state = c === MINUS ? S_DTD_COMMENT_ENDED : S_DTD_COMMENT;
      }
      sDTDCommentEnded() {
        const c = this.getCodeNorm();
        this.text += String.fromCodePoint(c);
        if (c === GREATER) {
          this.state = S_DTD;
        } else {
          this.fail("malformed comment.");
          this.state = S_DTD_COMMENT;
        }
      }
      sDTDPI() {
        if (this.captureToChar(QUESTION)) {
          this.text += "?";
          this.state = S_DTD_PI_ENDING;
        }
      }
      sDTDPIEnding() {
        const c = this.getCodeNorm();
        this.text += String.fromCodePoint(c);
        if (c === GREATER) {
          this.state = S_DTD;
        }
      }
      sText() {
        if (this.tags.length !== 0) {
          this.handleTextInRoot();
        } else {
          this.handleTextOutsideRoot();
        }
      }
      sEntity() {
        let { i: start } = this;
        const { chunk } = this;
        loop:
          while (true) {
            switch (this.getCode()) {
              case NL_LIKE:
                this.entity += `${chunk.slice(start, this.prevI)}
`;
                start = this.i;
                break;
              case SEMICOLON: {
                const { entityReturnState } = this;
                const entity = this.entity + chunk.slice(start, this.prevI);
                this.state = entityReturnState;
                let parsed;
                if (entity === "") {
                  this.fail("empty entity name.");
                  parsed = "&;";
                } else {
                  parsed = this.parseEntity(entity);
                  this.entity = "";
                }
                if (entityReturnState !== S_TEXT || this.textHandler !== void 0) {
                  this.text += parsed;
                }
                break loop;
              }
              case EOC:
                this.entity += chunk.slice(start);
                break loop;
              default:
            }
          }
      }
      sOpenWaka() {
        const c = this.getCode();
        if (isNameStartChar(c)) {
          this.state = S_OPEN_TAG;
          this.unget();
          this.xmlDeclPossible = false;
        } else {
          switch (c) {
            case FORWARD_SLASH:
              this.state = S_CLOSE_TAG;
              this.xmlDeclPossible = false;
              break;
            case BANG:
              this.state = S_OPEN_WAKA_BANG;
              this.openWakaBang = "";
              this.xmlDeclPossible = false;
              break;
            case QUESTION:
              this.state = S_PI_FIRST_CHAR;
              break;
            default:
              this.fail("disallowed character in tag name");
              this.state = S_TEXT;
              this.xmlDeclPossible = false;
          }
        }
      }
      sOpenWakaBang() {
        this.openWakaBang += String.fromCodePoint(this.getCodeNorm());
        switch (this.openWakaBang) {
          case "[CDATA[":
            if (!this.sawRoot && !this.reportedTextBeforeRoot) {
              this.fail("text data outside of root node.");
              this.reportedTextBeforeRoot = true;
            }
            if (this.closedRoot && !this.reportedTextAfterRoot) {
              this.fail("text data outside of root node.");
              this.reportedTextAfterRoot = true;
            }
            this.state = S_CDATA;
            this.openWakaBang = "";
            break;
          case "--":
            this.state = S_COMMENT;
            this.openWakaBang = "";
            break;
          case "DOCTYPE":
            this.state = S_DOCTYPE;
            if (this.doctype || this.sawRoot) {
              this.fail("inappropriately located doctype declaration.");
            }
            this.openWakaBang = "";
            break;
          default:
            if (this.openWakaBang.length >= 7) {
              this.fail("incorrect syntax.");
            }
        }
      }
      sComment() {
        if (this.captureToChar(MINUS)) {
          this.state = S_COMMENT_ENDING;
        }
      }
      sCommentEnding() {
        var _a;
        const c = this.getCodeNorm();
        if (c === MINUS) {
          this.state = S_COMMENT_ENDED;
          (_a = this.commentHandler) === null || _a === void 0 ? void 0 : _a.call(this, this.text);
          this.text = "";
        } else {
          this.text += `-${String.fromCodePoint(c)}`;
          this.state = S_COMMENT;
        }
      }
      sCommentEnded() {
        const c = this.getCodeNorm();
        if (c !== GREATER) {
          this.fail("malformed comment.");
          this.text += `--${String.fromCodePoint(c)}`;
          this.state = S_COMMENT;
        } else {
          this.state = S_TEXT;
        }
      }
      sCData() {
        if (this.captureToChar(CLOSE_BRACKET)) {
          this.state = S_CDATA_ENDING;
        }
      }
      sCDataEnding() {
        const c = this.getCodeNorm();
        if (c === CLOSE_BRACKET) {
          this.state = S_CDATA_ENDING_2;
        } else {
          this.text += `]${String.fromCodePoint(c)}`;
          this.state = S_CDATA;
        }
      }
      sCDataEnding2() {
        var _a;
        const c = this.getCodeNorm();
        switch (c) {
          case GREATER: {
            (_a = this.cdataHandler) === null || _a === void 0 ? void 0 : _a.call(this, this.text);
            this.text = "";
            this.state = S_TEXT;
            break;
          }
          case CLOSE_BRACKET:
            this.text += "]";
            break;
          default:
            this.text += `]]${String.fromCodePoint(c)}`;
            this.state = S_CDATA;
        }
      }
      // We need this separate state to check the first character fo the pi target
      // with this.nameStartCheck which allows less characters than this.nameCheck.
      sPIFirstChar() {
        const c = this.getCodeNorm();
        if (this.nameStartCheck(c)) {
          this.piTarget += String.fromCodePoint(c);
          this.state = S_PI_REST;
        } else if (c === QUESTION || isS(c)) {
          this.fail("processing instruction without a target.");
          this.state = c === QUESTION ? S_PI_ENDING : S_PI_BODY;
        } else {
          this.fail("disallowed character in processing instruction name.");
          this.piTarget += String.fromCodePoint(c);
          this.state = S_PI_REST;
        }
      }
      sPIRest() {
        const { chunk, i: start } = this;
        while (true) {
          const c = this.getCodeNorm();
          if (c === EOC) {
            this.piTarget += chunk.slice(start);
            return;
          }
          if (!this.nameCheck(c)) {
            this.piTarget += chunk.slice(start, this.prevI);
            const isQuestion = c === QUESTION;
            if (isQuestion || isS(c)) {
              if (this.piTarget === "xml") {
                if (!this.xmlDeclPossible) {
                  this.fail("an XML declaration must be at the start of the document.");
                }
                this.state = isQuestion ? S_XML_DECL_ENDING : S_XML_DECL_NAME_START;
              } else {
                this.state = isQuestion ? S_PI_ENDING : S_PI_BODY;
              }
            } else {
              this.fail("disallowed character in processing instruction name.");
              this.piTarget += String.fromCodePoint(c);
            }
            break;
          }
        }
      }
      sPIBody() {
        if (this.text.length === 0) {
          const c = this.getCodeNorm();
          if (c === QUESTION) {
            this.state = S_PI_ENDING;
          } else if (!isS(c)) {
            this.text = String.fromCodePoint(c);
          }
        } else if (this.captureToChar(QUESTION)) {
          this.state = S_PI_ENDING;
        }
      }
      sPIEnding() {
        var _a;
        const c = this.getCodeNorm();
        if (c === GREATER) {
          const { piTarget } = this;
          if (piTarget.toLowerCase() === "xml") {
            this.fail("the XML declaration must appear at the start of the document.");
          }
          (_a = this.piHandler) === null || _a === void 0 ? void 0 : _a.call(this, {
            target: piTarget,
            body: this.text
          });
          this.piTarget = this.text = "";
          this.state = S_TEXT;
        } else if (c === QUESTION) {
          this.text += "?";
        } else {
          this.text += `?${String.fromCodePoint(c)}`;
          this.state = S_PI_BODY;
        }
        this.xmlDeclPossible = false;
      }
      sXMLDeclNameStart() {
        const c = this.skipSpaces();
        if (c === QUESTION) {
          this.state = S_XML_DECL_ENDING;
          return;
        }
        if (c !== EOC) {
          this.state = S_XML_DECL_NAME;
          this.name = String.fromCodePoint(c);
        }
      }
      sXMLDeclName() {
        const c = this.captureTo(XML_DECL_NAME_TERMINATOR);
        if (c === QUESTION) {
          this.state = S_XML_DECL_ENDING;
          this.name += this.text;
          this.text = "";
          this.fail("XML declaration is incomplete.");
          return;
        }
        if (!(isS(c) || c === EQUAL)) {
          return;
        }
        this.name += this.text;
        this.text = "";
        if (!this.xmlDeclExpects.includes(this.name)) {
          switch (this.name.length) {
            case 0:
              this.fail("did not expect any more name/value pairs.");
              break;
            case 1:
              this.fail(`expected the name ${this.xmlDeclExpects[0]}.`);
              break;
            default:
              this.fail(`expected one of ${this.xmlDeclExpects.join(", ")}`);
          }
        }
        this.state = c === EQUAL ? S_XML_DECL_VALUE_START : S_XML_DECL_EQ;
      }
      sXMLDeclEq() {
        const c = this.getCodeNorm();
        if (c === QUESTION) {
          this.state = S_XML_DECL_ENDING;
          this.fail("XML declaration is incomplete.");
          return;
        }
        if (isS(c)) {
          return;
        }
        if (c !== EQUAL) {
          this.fail("value required.");
        }
        this.state = S_XML_DECL_VALUE_START;
      }
      sXMLDeclValueStart() {
        const c = this.getCodeNorm();
        if (c === QUESTION) {
          this.state = S_XML_DECL_ENDING;
          this.fail("XML declaration is incomplete.");
          return;
        }
        if (isS(c)) {
          return;
        }
        if (!isQuote(c)) {
          this.fail("value must be quoted.");
          this.q = SPACE;
        } else {
          this.q = c;
        }
        this.state = S_XML_DECL_VALUE;
      }
      sXMLDeclValue() {
        const c = this.captureTo([this.q, QUESTION]);
        if (c === QUESTION) {
          this.state = S_XML_DECL_ENDING;
          this.text = "";
          this.fail("XML declaration is incomplete.");
          return;
        }
        if (c === EOC) {
          return;
        }
        const value = this.text;
        this.text = "";
        switch (this.name) {
          case "version": {
            this.xmlDeclExpects = ["encoding", "standalone"];
            const version = value;
            this.xmlDecl.version = version;
            if (!/^1\.[0-9]+$/.test(version)) {
              this.fail("version number must match /^1\\.[0-9]+$/.");
            } else if (!this.opt.forceXMLVersion) {
              this.setXMLVersion(version);
            }
            break;
          }
          case "encoding":
            if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(value)) {
              this.fail("encoding value must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/.");
            }
            this.xmlDeclExpects = ["standalone"];
            this.xmlDecl.encoding = value;
            break;
          case "standalone":
            if (value !== "yes" && value !== "no") {
              this.fail('standalone value must match "yes" or "no".');
            }
            this.xmlDeclExpects = [];
            this.xmlDecl.standalone = value;
            break;
          default:
        }
        this.name = "";
        this.state = S_XML_DECL_SEPARATOR;
      }
      sXMLDeclSeparator() {
        const c = this.getCodeNorm();
        if (c === QUESTION) {
          this.state = S_XML_DECL_ENDING;
          return;
        }
        if (!isS(c)) {
          this.fail("whitespace required.");
          this.unget();
        }
        this.state = S_XML_DECL_NAME_START;
      }
      sXMLDeclEnding() {
        var _a;
        const c = this.getCodeNorm();
        if (c === GREATER) {
          if (this.piTarget !== "xml") {
            this.fail("processing instructions are not allowed before root.");
          } else if (this.name !== "version" && this.xmlDeclExpects.includes("version")) {
            this.fail("XML declaration must contain a version.");
          }
          (_a = this.xmldeclHandler) === null || _a === void 0 ? void 0 : _a.call(this, this.xmlDecl);
          this.name = "";
          this.piTarget = this.text = "";
          this.state = S_TEXT;
        } else {
          this.fail("The character ? is disallowed anywhere in XML declarations.");
        }
        this.xmlDeclPossible = false;
      }
      sOpenTag() {
        var _a;
        const c = this.captureNameChars();
        if (c === EOC) {
          return;
        }
        const tag = this.tag = {
          name: this.name,
          attributes: /* @__PURE__ */ Object.create(null)
        };
        this.name = "";
        if (this.xmlnsOpt) {
          this.topNS = tag.ns = /* @__PURE__ */ Object.create(null);
        }
        (_a = this.openTagStartHandler) === null || _a === void 0 ? void 0 : _a.call(this, tag);
        this.sawRoot = true;
        if (!this.fragmentOpt && this.closedRoot) {
          this.fail("documents may contain only one root.");
        }
        switch (c) {
          case GREATER:
            this.openTag();
            break;
          case FORWARD_SLASH:
            this.state = S_OPEN_TAG_SLASH;
            break;
          default:
            if (!isS(c)) {
              this.fail("disallowed character in tag name.");
            }
            this.state = S_ATTRIB;
        }
      }
      sOpenTagSlash() {
        if (this.getCode() === GREATER) {
          this.openSelfClosingTag();
        } else {
          this.fail("forward-slash in opening tag not followed by >.");
          this.state = S_ATTRIB;
        }
      }
      sAttrib() {
        const c = this.skipSpaces();
        if (c === EOC) {
          return;
        }
        if (isNameStartChar(c)) {
          this.unget();
          this.state = S_ATTRIB_NAME;
        } else if (c === GREATER) {
          this.openTag();
        } else if (c === FORWARD_SLASH) {
          this.state = S_OPEN_TAG_SLASH;
        } else {
          this.fail("disallowed character in attribute name.");
        }
      }
      sAttribName() {
        const c = this.captureNameChars();
        if (c === EQUAL) {
          this.state = S_ATTRIB_VALUE;
        } else if (isS(c)) {
          this.state = S_ATTRIB_NAME_SAW_WHITE;
        } else if (c === GREATER) {
          this.fail("attribute without value.");
          this.pushAttrib(this.name, this.name);
          this.name = this.text = "";
          this.openTag();
        } else if (c !== EOC) {
          this.fail("disallowed character in attribute name.");
        }
      }
      sAttribNameSawWhite() {
        const c = this.skipSpaces();
        switch (c) {
          case EOC:
            return;
          case EQUAL:
            this.state = S_ATTRIB_VALUE;
            break;
          default:
            this.fail("attribute without value.");
            this.text = "";
            this.name = "";
            if (c === GREATER) {
              this.openTag();
            } else if (isNameStartChar(c)) {
              this.unget();
              this.state = S_ATTRIB_NAME;
            } else {
              this.fail("disallowed character in attribute name.");
              this.state = S_ATTRIB;
            }
        }
      }
      sAttribValue() {
        const c = this.getCodeNorm();
        if (isQuote(c)) {
          this.q = c;
          this.state = S_ATTRIB_VALUE_QUOTED;
        } else if (!isS(c)) {
          this.fail("unquoted attribute value.");
          this.state = S_ATTRIB_VALUE_UNQUOTED;
          this.unget();
        }
      }
      sAttribValueQuoted() {
        const { q, chunk } = this;
        let { i: start } = this;
        while (true) {
          switch (this.getCode()) {
            case q:
              this.pushAttrib(this.name, this.text + chunk.slice(start, this.prevI));
              this.name = this.text = "";
              this.q = null;
              this.state = S_ATTRIB_VALUE_CLOSED;
              return;
            case AMP:
              this.text += chunk.slice(start, this.prevI);
              this.state = S_ENTITY;
              this.entityReturnState = S_ATTRIB_VALUE_QUOTED;
              return;
            case NL:
            case NL_LIKE:
            case TAB:
              this.text += `${chunk.slice(start, this.prevI)} `;
              start = this.i;
              break;
            case LESS:
              this.text += chunk.slice(start, this.prevI);
              this.fail("disallowed character.");
              return;
            case EOC:
              this.text += chunk.slice(start);
              return;
            default:
          }
        }
      }
      sAttribValueClosed() {
        const c = this.getCodeNorm();
        if (isS(c)) {
          this.state = S_ATTRIB;
        } else if (c === GREATER) {
          this.openTag();
        } else if (c === FORWARD_SLASH) {
          this.state = S_OPEN_TAG_SLASH;
        } else if (isNameStartChar(c)) {
          this.fail("no whitespace between attributes.");
          this.unget();
          this.state = S_ATTRIB_NAME;
        } else {
          this.fail("disallowed character in attribute name.");
        }
      }
      sAttribValueUnquoted() {
        const c = this.captureTo(ATTRIB_VALUE_UNQUOTED_TERMINATOR);
        switch (c) {
          case AMP:
            this.state = S_ENTITY;
            this.entityReturnState = S_ATTRIB_VALUE_UNQUOTED;
            break;
          case LESS:
            this.fail("disallowed character.");
            break;
          case EOC:
            break;
          default:
            if (this.text.includes("]]>")) {
              this.fail('the string "]]>" is disallowed in char data.');
            }
            this.pushAttrib(this.name, this.text);
            this.name = this.text = "";
            if (c === GREATER) {
              this.openTag();
            } else {
              this.state = S_ATTRIB;
            }
        }
      }
      sCloseTag() {
        const c = this.captureNameChars();
        if (c === GREATER) {
          this.closeTag();
        } else if (isS(c)) {
          this.state = S_CLOSE_TAG_SAW_WHITE;
        } else if (c !== EOC) {
          this.fail("disallowed character in closing tag.");
        }
      }
      sCloseTagSawWhite() {
        switch (this.skipSpaces()) {
          case GREATER:
            this.closeTag();
            break;
          case EOC:
            break;
          default:
            this.fail("disallowed character in closing tag.");
        }
      }
      // END OF STATE ENGINE METHODS
      handleTextInRoot() {
        let { i: start, forbiddenState } = this;
        const { chunk, textHandler: handler } = this;
        scanLoop:
          while (true) {
            switch (this.getCode()) {
              case LESS: {
                this.state = S_OPEN_WAKA;
                if (handler !== void 0) {
                  const { text } = this;
                  const slice = chunk.slice(start, this.prevI);
                  if (text.length !== 0) {
                    handler(text + slice);
                    this.text = "";
                  } else if (slice.length !== 0) {
                    handler(slice);
                  }
                }
                forbiddenState = FORBIDDEN_START;
                break scanLoop;
              }
              case AMP:
                this.state = S_ENTITY;
                this.entityReturnState = S_TEXT;
                if (handler !== void 0) {
                  this.text += chunk.slice(start, this.prevI);
                }
                forbiddenState = FORBIDDEN_START;
                break scanLoop;
              case CLOSE_BRACKET:
                switch (forbiddenState) {
                  case FORBIDDEN_START:
                    forbiddenState = FORBIDDEN_BRACKET;
                    break;
                  case FORBIDDEN_BRACKET:
                    forbiddenState = FORBIDDEN_BRACKET_BRACKET;
                    break;
                  case FORBIDDEN_BRACKET_BRACKET:
                    break;
                  default:
                    throw new Error("impossible state");
                }
                break;
              case GREATER:
                if (forbiddenState === FORBIDDEN_BRACKET_BRACKET) {
                  this.fail('the string "]]>" is disallowed in char data.');
                }
                forbiddenState = FORBIDDEN_START;
                break;
              case NL_LIKE:
                if (handler !== void 0) {
                  this.text += `${chunk.slice(start, this.prevI)}
`;
                }
                start = this.i;
                forbiddenState = FORBIDDEN_START;
                break;
              case EOC:
                if (handler !== void 0) {
                  this.text += chunk.slice(start);
                }
                break scanLoop;
              default:
                forbiddenState = FORBIDDEN_START;
            }
          }
        this.forbiddenState = forbiddenState;
      }
      handleTextOutsideRoot() {
        let { i: start } = this;
        const { chunk, textHandler: handler } = this;
        let nonSpace = false;
        outRootLoop:
          while (true) {
            const code = this.getCode();
            switch (code) {
              case LESS: {
                this.state = S_OPEN_WAKA;
                if (handler !== void 0) {
                  const { text } = this;
                  const slice = chunk.slice(start, this.prevI);
                  if (text.length !== 0) {
                    handler(text + slice);
                    this.text = "";
                  } else if (slice.length !== 0) {
                    handler(slice);
                  }
                }
                break outRootLoop;
              }
              case AMP:
                this.state = S_ENTITY;
                this.entityReturnState = S_TEXT;
                if (handler !== void 0) {
                  this.text += chunk.slice(start, this.prevI);
                }
                nonSpace = true;
                break outRootLoop;
              case NL_LIKE:
                if (handler !== void 0) {
                  this.text += `${chunk.slice(start, this.prevI)}
`;
                }
                start = this.i;
                break;
              case EOC:
                if (handler !== void 0) {
                  this.text += chunk.slice(start);
                }
                break outRootLoop;
              default:
                if (!isS(code)) {
                  nonSpace = true;
                }
            }
          }
        if (!nonSpace) {
          return;
        }
        if (!this.sawRoot && !this.reportedTextBeforeRoot) {
          this.fail("text data outside of root node.");
          this.reportedTextBeforeRoot = true;
        }
        if (this.closedRoot && !this.reportedTextAfterRoot) {
          this.fail("text data outside of root node.");
          this.reportedTextAfterRoot = true;
        }
      }
      pushAttribNS(name, value) {
        var _a;
        const { prefix, local } = this.qname(name);
        const attr = { name, prefix, local, value };
        this.attribList.push(attr);
        (_a = this.attributeHandler) === null || _a === void 0 ? void 0 : _a.call(this, attr);
        if (prefix === "xmlns") {
          const trimmed = value.trim();
          if (this.currentXMLVersion === "1.0" && trimmed === "") {
            this.fail("invalid attempt to undefine prefix in XML 1.0");
          }
          this.topNS[local] = trimmed;
          nsPairCheck(this, local, trimmed);
        } else if (name === "xmlns") {
          const trimmed = value.trim();
          this.topNS[""] = trimmed;
          nsPairCheck(this, "", trimmed);
        }
      }
      pushAttribPlain(name, value) {
        var _a;
        const attr = { name, value };
        this.attribList.push(attr);
        (_a = this.attributeHandler) === null || _a === void 0 ? void 0 : _a.call(this, attr);
      }
      /**
       * End parsing. This performs final well-formedness checks and resets the
       * parser to a clean state.
       *
       * @returns this
       */
      end() {
        var _a, _b;
        if (!this.sawRoot) {
          this.fail("document must contain a root element.");
        }
        const { tags } = this;
        while (tags.length > 0) {
          const tag = tags.pop();
          this.fail(`unclosed tag: ${tag.name}`);
        }
        if (this.state !== S_BEGIN && this.state !== S_TEXT) {
          this.fail("unexpected end.");
        }
        const { text } = this;
        if (text.length !== 0) {
          (_a = this.textHandler) === null || _a === void 0 ? void 0 : _a.call(this, text);
          this.text = "";
        }
        this._closed = true;
        (_b = this.endHandler) === null || _b === void 0 ? void 0 : _b.call(this);
        this._init();
        return this;
      }
      /**
       * Resolve a namespace prefix.
       *
       * @param prefix The prefix to resolve.
       *
       * @returns The namespace URI or ``undefined`` if the prefix is not defined.
       */
      resolve(prefix) {
        var _a, _b;
        let uri = this.topNS[prefix];
        if (uri !== void 0) {
          return uri;
        }
        const { tags } = this;
        for (let index = tags.length - 1; index >= 0; index--) {
          uri = tags[index].ns[prefix];
          if (uri !== void 0) {
            return uri;
          }
        }
        uri = this.ns[prefix];
        if (uri !== void 0) {
          return uri;
        }
        return (_b = (_a = this.opt).resolvePrefix) === null || _b === void 0 ? void 0 : _b.call(_a, prefix);
      }
      /**
       * Parse a qname into its prefix and local name parts.
       *
       * @param name The name to parse
       *
       * @returns
       */
      qname(name) {
        const colon = name.indexOf(":");
        if (colon === -1) {
          return { prefix: "", local: name };
        }
        const local = name.slice(colon + 1);
        const prefix = name.slice(0, colon);
        if (prefix === "" || local === "" || local.includes(":")) {
          this.fail(`malformed name: ${name}.`);
        }
        return { prefix, local };
      }
      processAttribsNS() {
        var _a;
        const { attribList } = this;
        const tag = this.tag;
        {
          const { prefix, local } = this.qname(tag.name);
          tag.prefix = prefix;
          tag.local = local;
          const uri = tag.uri = (_a = this.resolve(prefix)) !== null && _a !== void 0 ? _a : "";
          if (prefix !== "") {
            if (prefix === "xmlns") {
              this.fail('tags may not have "xmlns" as prefix.');
            }
            if (uri === "") {
              this.fail(`unbound namespace prefix: ${JSON.stringify(prefix)}.`);
              tag.uri = prefix;
            }
          }
        }
        if (attribList.length === 0) {
          return;
        }
        const { attributes } = tag;
        const seen = /* @__PURE__ */ new Set();
        for (const attr of attribList) {
          const { name, prefix, local } = attr;
          let uri;
          let eqname;
          if (prefix === "") {
            uri = name === "xmlns" ? XMLNS_NAMESPACE : "";
            eqname = name;
          } else {
            uri = this.resolve(prefix);
            if (uri === void 0) {
              this.fail(`unbound namespace prefix: ${JSON.stringify(prefix)}.`);
              uri = prefix;
            }
            eqname = `{${uri}}${local}`;
          }
          if (seen.has(eqname)) {
            this.fail(`duplicate attribute: ${eqname}.`);
          }
          seen.add(eqname);
          attr.uri = uri;
          attributes[name] = attr;
        }
        this.attribList = [];
      }
      processAttribsPlain() {
        const { attribList } = this;
        const attributes = this.tag.attributes;
        for (const { name, value } of attribList) {
          if (attributes[name] !== void 0) {
            this.fail(`duplicate attribute: ${name}.`);
          }
          attributes[name] = value;
        }
        this.attribList = [];
      }
      /**
       * Handle a complete open tag. This parser code calls this once it has seen
       * the whole tag. This method checks for well-formeness and then emits
       * ``onopentag``.
       */
      openTag() {
        var _a;
        this.processAttribs();
        const { tags } = this;
        const tag = this.tag;
        tag.isSelfClosing = false;
        (_a = this.openTagHandler) === null || _a === void 0 ? void 0 : _a.call(this, tag);
        tags.push(tag);
        this.state = S_TEXT;
        this.name = "";
      }
      /**
       * Handle a complete self-closing tag. This parser code calls this once it has
       * seen the whole tag. This method checks for well-formeness and then emits
       * ``onopentag`` and ``onclosetag``.
       */
      openSelfClosingTag() {
        var _a, _b, _c;
        this.processAttribs();
        const { tags } = this;
        const tag = this.tag;
        tag.isSelfClosing = true;
        (_a = this.openTagHandler) === null || _a === void 0 ? void 0 : _a.call(this, tag);
        (_b = this.closeTagHandler) === null || _b === void 0 ? void 0 : _b.call(this, tag);
        const top = this.tag = (_c = tags[tags.length - 1]) !== null && _c !== void 0 ? _c : null;
        if (top === null) {
          this.closedRoot = true;
        }
        this.state = S_TEXT;
        this.name = "";
      }
      /**
       * Handle a complete close tag. This parser code calls this once it has seen
       * the whole tag. This method checks for well-formeness and then emits
       * ``onclosetag``.
       */
      closeTag() {
        const { tags, name } = this;
        this.state = S_TEXT;
        this.name = "";
        if (name === "") {
          this.fail("weird empty close tag.");
          this.text += "</>";
          return;
        }
        const handler = this.closeTagHandler;
        let l = tags.length;
        while (l-- > 0) {
          const tag = this.tag = tags.pop();
          this.topNS = tag.ns;
          handler === null || handler === void 0 ? void 0 : handler(tag);
          if (tag.name === name) {
            break;
          }
          this.fail("unexpected close tag.");
        }
        if (l === 0) {
          this.closedRoot = true;
        } else if (l < 0) {
          this.fail(`unmatched closing tag: ${name}.`);
          this.text += `</${name}>`;
        }
      }
      /**
       * Resolves an entity. Makes any necessary well-formedness checks.
       *
       * @param entity The entity to resolve.
       *
       * @returns The parsed entity.
       */
      parseEntity(entity) {
        if (entity[0] !== "#") {
          const defined = this.ENTITIES[entity];
          if (defined !== void 0) {
            return defined;
          }
          this.fail(this.isName(entity) ? "undefined entity." : "disallowed character in entity name.");
          return `&${entity};`;
        }
        let num = NaN;
        if (entity[1] === "x" && /^#x[0-9a-f]+$/i.test(entity)) {
          num = parseInt(entity.slice(2), 16);
        } else if (/^#[0-9]+$/.test(entity)) {
          num = parseInt(entity.slice(1), 10);
        }
        if (!this.isChar(num)) {
          this.fail("malformed character entity.");
          return `&${entity};`;
        }
        return String.fromCodePoint(num);
      }
    };
    exports2.SaxesParser = SaxesParser;
  }
});

// node_modules/pend/index.js
var require_pend = __commonJS({
  "node_modules/pend/index.js"(exports2, module2) {
    module2.exports = Pend;
    function Pend() {
      this.pending = 0;
      this.max = Infinity;
      this.listeners = [];
      this.waiting = [];
      this.error = null;
    }
    Pend.prototype.go = function(fn) {
      if (this.pending < this.max) {
        pendGo(this, fn);
      } else {
        this.waiting.push(fn);
      }
    };
    Pend.prototype.wait = function(cb) {
      if (this.pending === 0) {
        cb(this.error);
      } else {
        this.listeners.push(cb);
      }
    };
    Pend.prototype.hold = function() {
      return pendHold(this);
    };
    function pendHold(self) {
      self.pending += 1;
      var called = false;
      return onCb;
      function onCb(err) {
        if (called) throw new Error("callback called twice");
        called = true;
        self.error = self.error || err;
        self.pending -= 1;
        if (self.waiting.length > 0 && self.pending < self.max) {
          pendGo(self, self.waiting.shift());
        } else if (self.pending === 0) {
          var listeners = self.listeners;
          self.listeners = [];
          listeners.forEach(cbListener);
        }
      }
      function cbListener(listener) {
        listener(self.error);
      }
    }
    function pendGo(self, fn) {
      fn(pendHold(self));
    }
  }
});

// node_modules/fd-slicer/index.js
var require_fd_slicer = __commonJS({
  "node_modules/fd-slicer/index.js"(exports2) {
    var fs = require("fs");
    var util = require("util");
    var stream = require("stream");
    var Readable = stream.Readable;
    var Writable = stream.Writable;
    var PassThrough = stream.PassThrough;
    var Pend = require_pend();
    var EventEmitter = require("events").EventEmitter;
    exports2.createFromBuffer = createFromBuffer;
    exports2.createFromFd = createFromFd;
    exports2.BufferSlicer = BufferSlicer;
    exports2.FdSlicer = FdSlicer;
    util.inherits(FdSlicer, EventEmitter);
    function FdSlicer(fd, options) {
      options = options || {};
      EventEmitter.call(this);
      this.fd = fd;
      this.pend = new Pend();
      this.pend.max = 1;
      this.refCount = 0;
      this.autoClose = !!options.autoClose;
    }
    FdSlicer.prototype.read = function(buffer, offset, length, position, callback) {
      var self = this;
      self.pend.go(function(cb) {
        fs.read(self.fd, buffer, offset, length, position, function(err, bytesRead, buffer2) {
          cb();
          callback(err, bytesRead, buffer2);
        });
      });
    };
    FdSlicer.prototype.write = function(buffer, offset, length, position, callback) {
      var self = this;
      self.pend.go(function(cb) {
        fs.write(self.fd, buffer, offset, length, position, function(err, written, buffer2) {
          cb();
          callback(err, written, buffer2);
        });
      });
    };
    FdSlicer.prototype.createReadStream = function(options) {
      return new ReadStream(this, options);
    };
    FdSlicer.prototype.createWriteStream = function(options) {
      return new WriteStream(this, options);
    };
    FdSlicer.prototype.ref = function() {
      this.refCount += 1;
    };
    FdSlicer.prototype.unref = function() {
      var self = this;
      self.refCount -= 1;
      if (self.refCount > 0) return;
      if (self.refCount < 0) throw new Error("invalid unref");
      if (self.autoClose) {
        fs.close(self.fd, onCloseDone);
      }
      function onCloseDone(err) {
        if (err) {
          self.emit("error", err);
        } else {
          self.emit("close");
        }
      }
    };
    util.inherits(ReadStream, Readable);
    function ReadStream(context, options) {
      options = options || {};
      Readable.call(this, options);
      this.context = context;
      this.context.ref();
      this.start = options.start || 0;
      this.endOffset = options.end;
      this.pos = this.start;
      this.destroyed = false;
    }
    ReadStream.prototype._read = function(n) {
      var self = this;
      if (self.destroyed) return;
      var toRead = Math.min(self._readableState.highWaterMark, n);
      if (self.endOffset != null) {
        toRead = Math.min(toRead, self.endOffset - self.pos);
      }
      if (toRead <= 0) {
        self.destroyed = true;
        self.push(null);
        self.context.unref();
        return;
      }
      self.context.pend.go(function(cb) {
        if (self.destroyed) return cb();
        var buffer = new Buffer(toRead);
        fs.read(self.context.fd, buffer, 0, toRead, self.pos, function(err, bytesRead) {
          if (err) {
            self.destroy(err);
          } else if (bytesRead === 0) {
            self.destroyed = true;
            self.push(null);
            self.context.unref();
          } else {
            self.pos += bytesRead;
            self.push(buffer.slice(0, bytesRead));
          }
          cb();
        });
      });
    };
    ReadStream.prototype.destroy = function(err) {
      if (this.destroyed) return;
      err = err || new Error("stream destroyed");
      this.destroyed = true;
      this.emit("error", err);
      this.context.unref();
    };
    util.inherits(WriteStream, Writable);
    function WriteStream(context, options) {
      options = options || {};
      Writable.call(this, options);
      this.context = context;
      this.context.ref();
      this.start = options.start || 0;
      this.endOffset = options.end == null ? Infinity : +options.end;
      this.bytesWritten = 0;
      this.pos = this.start;
      this.destroyed = false;
      this.on("finish", this.destroy.bind(this));
    }
    WriteStream.prototype._write = function(buffer, encoding, callback) {
      var self = this;
      if (self.destroyed) return;
      if (self.pos + buffer.length > self.endOffset) {
        var err = new Error("maximum file length exceeded");
        err.code = "ETOOBIG";
        self.destroy();
        callback(err);
        return;
      }
      self.context.pend.go(function(cb) {
        if (self.destroyed) return cb();
        fs.write(self.context.fd, buffer, 0, buffer.length, self.pos, function(err2, bytes) {
          if (err2) {
            self.destroy();
            cb();
            callback(err2);
          } else {
            self.bytesWritten += bytes;
            self.pos += bytes;
            self.emit("progress");
            cb();
            callback();
          }
        });
      });
    };
    WriteStream.prototype.destroy = function() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.context.unref();
    };
    util.inherits(BufferSlicer, EventEmitter);
    function BufferSlicer(buffer, options) {
      EventEmitter.call(this);
      options = options || {};
      this.refCount = 0;
      this.buffer = buffer;
      this.maxChunkSize = options.maxChunkSize || Number.MAX_SAFE_INTEGER;
    }
    BufferSlicer.prototype.read = function(buffer, offset, length, position, callback) {
      var end = position + length;
      var delta = end - this.buffer.length;
      var written = delta > 0 ? delta : length;
      this.buffer.copy(buffer, offset, position, end);
      setImmediate(function() {
        callback(null, written);
      });
    };
    BufferSlicer.prototype.write = function(buffer, offset, length, position, callback) {
      buffer.copy(this.buffer, position, offset, offset + length);
      setImmediate(function() {
        callback(null, length, buffer);
      });
    };
    BufferSlicer.prototype.createReadStream = function(options) {
      options = options || {};
      var readStream = new PassThrough(options);
      readStream.destroyed = false;
      readStream.start = options.start || 0;
      readStream.endOffset = options.end;
      readStream.pos = readStream.endOffset || this.buffer.length;
      var entireSlice = this.buffer.slice(readStream.start, readStream.pos);
      var offset = 0;
      while (true) {
        var nextOffset = offset + this.maxChunkSize;
        if (nextOffset >= entireSlice.length) {
          if (offset < entireSlice.length) {
            readStream.write(entireSlice.slice(offset, entireSlice.length));
          }
          break;
        }
        readStream.write(entireSlice.slice(offset, nextOffset));
        offset = nextOffset;
      }
      readStream.end();
      readStream.destroy = function() {
        readStream.destroyed = true;
      };
      return readStream;
    };
    BufferSlicer.prototype.createWriteStream = function(options) {
      var bufferSlicer = this;
      options = options || {};
      var writeStream = new Writable(options);
      writeStream.start = options.start || 0;
      writeStream.endOffset = options.end == null ? this.buffer.length : +options.end;
      writeStream.bytesWritten = 0;
      writeStream.pos = writeStream.start;
      writeStream.destroyed = false;
      writeStream._write = function(buffer, encoding, callback) {
        if (writeStream.destroyed) return;
        var end = writeStream.pos + buffer.length;
        if (end > writeStream.endOffset) {
          var err = new Error("maximum file length exceeded");
          err.code = "ETOOBIG";
          writeStream.destroyed = true;
          callback(err);
          return;
        }
        buffer.copy(bufferSlicer.buffer, writeStream.pos, 0, buffer.length);
        writeStream.bytesWritten += buffer.length;
        writeStream.pos = end;
        writeStream.emit("progress");
        callback();
      };
      writeStream.destroy = function() {
        writeStream.destroyed = true;
      };
      return writeStream;
    };
    BufferSlicer.prototype.ref = function() {
      this.refCount += 1;
    };
    BufferSlicer.prototype.unref = function() {
      this.refCount -= 1;
      if (this.refCount < 0) {
        throw new Error("invalid unref");
      }
    };
    function createFromBuffer(buffer, options) {
      return new BufferSlicer(buffer, options);
    }
    function createFromFd(fd, options) {
      return new FdSlicer(fd, options);
    }
  }
});

// node_modules/buffer-crc32/index.js
var require_buffer_crc32 = __commonJS({
  "node_modules/buffer-crc32/index.js"(exports2, module2) {
    var Buffer2 = require("buffer").Buffer;
    var CRC_TABLE = [
      0,
      1996959894,
      3993919788,
      2567524794,
      124634137,
      1886057615,
      3915621685,
      2657392035,
      249268274,
      2044508324,
      3772115230,
      2547177864,
      162941995,
      2125561021,
      3887607047,
      2428444049,
      498536548,
      1789927666,
      4089016648,
      2227061214,
      450548861,
      1843258603,
      4107580753,
      2211677639,
      325883990,
      1684777152,
      4251122042,
      2321926636,
      335633487,
      1661365465,
      4195302755,
      2366115317,
      997073096,
      1281953886,
      3579855332,
      2724688242,
      1006888145,
      1258607687,
      3524101629,
      2768942443,
      901097722,
      1119000684,
      3686517206,
      2898065728,
      853044451,
      1172266101,
      3705015759,
      2882616665,
      651767980,
      1373503546,
      3369554304,
      3218104598,
      565507253,
      1454621731,
      3485111705,
      3099436303,
      671266974,
      1594198024,
      3322730930,
      2970347812,
      795835527,
      1483230225,
      3244367275,
      3060149565,
      1994146192,
      31158534,
      2563907772,
      4023717930,
      1907459465,
      112637215,
      2680153253,
      3904427059,
      2013776290,
      251722036,
      2517215374,
      3775830040,
      2137656763,
      141376813,
      2439277719,
      3865271297,
      1802195444,
      476864866,
      2238001368,
      4066508878,
      1812370925,
      453092731,
      2181625025,
      4111451223,
      1706088902,
      314042704,
      2344532202,
      4240017532,
      1658658271,
      366619977,
      2362670323,
      4224994405,
      1303535960,
      984961486,
      2747007092,
      3569037538,
      1256170817,
      1037604311,
      2765210733,
      3554079995,
      1131014506,
      879679996,
      2909243462,
      3663771856,
      1141124467,
      855842277,
      2852801631,
      3708648649,
      1342533948,
      654459306,
      3188396048,
      3373015174,
      1466479909,
      544179635,
      3110523913,
      3462522015,
      1591671054,
      702138776,
      2966460450,
      3352799412,
      1504918807,
      783551873,
      3082640443,
      3233442989,
      3988292384,
      2596254646,
      62317068,
      1957810842,
      3939845945,
      2647816111,
      81470997,
      1943803523,
      3814918930,
      2489596804,
      225274430,
      2053790376,
      3826175755,
      2466906013,
      167816743,
      2097651377,
      4027552580,
      2265490386,
      503444072,
      1762050814,
      4150417245,
      2154129355,
      426522225,
      1852507879,
      4275313526,
      2312317920,
      282753626,
      1742555852,
      4189708143,
      2394877945,
      397917763,
      1622183637,
      3604390888,
      2714866558,
      953729732,
      1340076626,
      3518719985,
      2797360999,
      1068828381,
      1219638859,
      3624741850,
      2936675148,
      906185462,
      1090812512,
      3747672003,
      2825379669,
      829329135,
      1181335161,
      3412177804,
      3160834842,
      628085408,
      1382605366,
      3423369109,
      3138078467,
      570562233,
      1426400815,
      3317316542,
      2998733608,
      733239954,
      1555261956,
      3268935591,
      3050360625,
      752459403,
      1541320221,
      2607071920,
      3965973030,
      1969922972,
      40735498,
      2617837225,
      3943577151,
      1913087877,
      83908371,
      2512341634,
      3803740692,
      2075208622,
      213261112,
      2463272603,
      3855990285,
      2094854071,
      198958881,
      2262029012,
      4057260610,
      1759359992,
      534414190,
      2176718541,
      4139329115,
      1873836001,
      414664567,
      2282248934,
      4279200368,
      1711684554,
      285281116,
      2405801727,
      4167216745,
      1634467795,
      376229701,
      2685067896,
      3608007406,
      1308918612,
      956543938,
      2808555105,
      3495958263,
      1231636301,
      1047427035,
      2932959818,
      3654703836,
      1088359270,
      936918e3,
      2847714899,
      3736837829,
      1202900863,
      817233897,
      3183342108,
      3401237130,
      1404277552,
      615818150,
      3134207493,
      3453421203,
      1423857449,
      601450431,
      3009837614,
      3294710456,
      1567103746,
      711928724,
      3020668471,
      3272380065,
      1510334235,
      755167117
    ];
    if (typeof Int32Array !== "undefined") {
      CRC_TABLE = new Int32Array(CRC_TABLE);
    }
    function ensureBuffer(input) {
      if (Buffer2.isBuffer(input)) {
        return input;
      }
      var hasNewBufferAPI = typeof Buffer2.alloc === "function" && typeof Buffer2.from === "function";
      if (typeof input === "number") {
        return hasNewBufferAPI ? Buffer2.alloc(input) : new Buffer2(input);
      } else if (typeof input === "string") {
        return hasNewBufferAPI ? Buffer2.from(input) : new Buffer2(input);
      } else {
        throw new Error("input must be buffer, number, or string, received " + typeof input);
      }
    }
    function bufferizeInt(num) {
      var tmp = ensureBuffer(4);
      tmp.writeInt32BE(num, 0);
      return tmp;
    }
    function _crc32(buf, previous) {
      buf = ensureBuffer(buf);
      if (Buffer2.isBuffer(previous)) {
        previous = previous.readUInt32BE(0);
      }
      var crc = ~~previous ^ -1;
      for (var n = 0; n < buf.length; n++) {
        crc = CRC_TABLE[(crc ^ buf[n]) & 255] ^ crc >>> 8;
      }
      return crc ^ -1;
    }
    function crc32() {
      return bufferizeInt(_crc32.apply(null, arguments));
    }
    crc32.signed = function() {
      return _crc32.apply(null, arguments);
    };
    crc32.unsigned = function() {
      return _crc32.apply(null, arguments) >>> 0;
    };
    module2.exports = crc32;
  }
});

// node_modules/yauzl/index.js
var require_yauzl = __commonJS({
  "node_modules/yauzl/index.js"(exports2) {
    var fs = require("fs");
    var zlib = require("zlib");
    var fd_slicer = require_fd_slicer();
    var crc32 = require_buffer_crc32();
    var util = require("util");
    var EventEmitter = require("events").EventEmitter;
    var Transform = require("stream").Transform;
    var PassThrough = require("stream").PassThrough;
    var Writable = require("stream").Writable;
    exports2.open = open;
    exports2.fromFd = fromFd;
    exports2.fromBuffer = fromBuffer;
    exports2.fromRandomAccessReader = fromRandomAccessReader;
    exports2.dosDateTimeToDate = dosDateTimeToDate;
    exports2.validateFileName = validateFileName;
    exports2.ZipFile = ZipFile;
    exports2.Entry = Entry;
    exports2.RandomAccessReader = RandomAccessReader;
    function open(path, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = null;
      }
      if (options == null) options = {};
      if (options.autoClose == null) options.autoClose = true;
      if (options.lazyEntries == null) options.lazyEntries = false;
      if (options.decodeStrings == null) options.decodeStrings = true;
      if (options.validateEntrySizes == null) options.validateEntrySizes = true;
      if (options.strictFileNames == null) options.strictFileNames = false;
      if (callback == null) callback = defaultCallback;
      fs.open(path, "r", function(err, fd) {
        if (err) return callback(err);
        fromFd(fd, options, function(err2, zipfile) {
          if (err2) fs.close(fd, defaultCallback);
          callback(err2, zipfile);
        });
      });
    }
    function fromFd(fd, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = null;
      }
      if (options == null) options = {};
      if (options.autoClose == null) options.autoClose = false;
      if (options.lazyEntries == null) options.lazyEntries = false;
      if (options.decodeStrings == null) options.decodeStrings = true;
      if (options.validateEntrySizes == null) options.validateEntrySizes = true;
      if (options.strictFileNames == null) options.strictFileNames = false;
      if (callback == null) callback = defaultCallback;
      fs.fstat(fd, function(err, stats) {
        if (err) return callback(err);
        var reader = fd_slicer.createFromFd(fd, { autoClose: true });
        fromRandomAccessReader(reader, stats.size, options, callback);
      });
    }
    function fromBuffer(buffer, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = null;
      }
      if (options == null) options = {};
      options.autoClose = false;
      if (options.lazyEntries == null) options.lazyEntries = false;
      if (options.decodeStrings == null) options.decodeStrings = true;
      if (options.validateEntrySizes == null) options.validateEntrySizes = true;
      if (options.strictFileNames == null) options.strictFileNames = false;
      var reader = fd_slicer.createFromBuffer(buffer, { maxChunkSize: 65536 });
      fromRandomAccessReader(reader, buffer.length, options, callback);
    }
    function fromRandomAccessReader(reader, totalSize, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = null;
      }
      if (options == null) options = {};
      if (options.autoClose == null) options.autoClose = true;
      if (options.lazyEntries == null) options.lazyEntries = false;
      if (options.decodeStrings == null) options.decodeStrings = true;
      var decodeStrings = !!options.decodeStrings;
      if (options.validateEntrySizes == null) options.validateEntrySizes = true;
      if (options.strictFileNames == null) options.strictFileNames = false;
      if (callback == null) callback = defaultCallback;
      if (typeof totalSize !== "number") throw new Error("expected totalSize parameter to be a number");
      if (totalSize > Number.MAX_SAFE_INTEGER) {
        throw new Error("zip file too large. only file sizes up to 2^52 are supported due to JavaScript's Number type being an IEEE 754 double.");
      }
      reader.ref();
      var eocdrWithoutCommentSize = 22;
      var maxCommentSize = 65535;
      var bufferSize = Math.min(eocdrWithoutCommentSize + maxCommentSize, totalSize);
      var buffer = newBuffer(bufferSize);
      var bufferReadStart = totalSize - buffer.length;
      readAndAssertNoEof(reader, buffer, 0, bufferSize, bufferReadStart, function(err) {
        if (err) return callback(err);
        for (var i = bufferSize - eocdrWithoutCommentSize; i >= 0; i -= 1) {
          if (buffer.readUInt32LE(i) !== 101010256) continue;
          var eocdrBuffer = buffer.slice(i);
          var diskNumber = eocdrBuffer.readUInt16LE(4);
          if (diskNumber !== 0) {
            return callback(new Error("multi-disk zip files are not supported: found disk number: " + diskNumber));
          }
          var entryCount = eocdrBuffer.readUInt16LE(10);
          var centralDirectoryOffset = eocdrBuffer.readUInt32LE(16);
          var commentLength = eocdrBuffer.readUInt16LE(20);
          var expectedCommentLength = eocdrBuffer.length - eocdrWithoutCommentSize;
          if (commentLength !== expectedCommentLength) {
            return callback(new Error("invalid comment length. expected: " + expectedCommentLength + ". found: " + commentLength));
          }
          var comment = decodeStrings ? decodeBuffer(eocdrBuffer, 22, eocdrBuffer.length, false) : eocdrBuffer.slice(22);
          if (!(entryCount === 65535 || centralDirectoryOffset === 4294967295)) {
            return callback(null, new ZipFile(reader, centralDirectoryOffset, totalSize, entryCount, comment, options.autoClose, options.lazyEntries, decodeStrings, options.validateEntrySizes, options.strictFileNames));
          }
          var zip64EocdlBuffer = newBuffer(20);
          var zip64EocdlOffset = bufferReadStart + i - zip64EocdlBuffer.length;
          readAndAssertNoEof(reader, zip64EocdlBuffer, 0, zip64EocdlBuffer.length, zip64EocdlOffset, function(err2) {
            if (err2) return callback(err2);
            if (zip64EocdlBuffer.readUInt32LE(0) !== 117853008) {
              return callback(new Error("invalid zip64 end of central directory locator signature"));
            }
            var zip64EocdrOffset = readUInt64LE(zip64EocdlBuffer, 8);
            var zip64EocdrBuffer = newBuffer(56);
            readAndAssertNoEof(reader, zip64EocdrBuffer, 0, zip64EocdrBuffer.length, zip64EocdrOffset, function(err3) {
              if (err3) return callback(err3);
              if (zip64EocdrBuffer.readUInt32LE(0) !== 101075792) {
                return callback(new Error("invalid zip64 end of central directory record signature"));
              }
              entryCount = readUInt64LE(zip64EocdrBuffer, 32);
              centralDirectoryOffset = readUInt64LE(zip64EocdrBuffer, 48);
              return callback(null, new ZipFile(reader, centralDirectoryOffset, totalSize, entryCount, comment, options.autoClose, options.lazyEntries, decodeStrings, options.validateEntrySizes, options.strictFileNames));
            });
          });
          return;
        }
        callback(new Error("end of central directory record signature not found"));
      });
    }
    util.inherits(ZipFile, EventEmitter);
    function ZipFile(reader, centralDirectoryOffset, fileSize, entryCount, comment, autoClose, lazyEntries, decodeStrings, validateEntrySizes, strictFileNames) {
      var self = this;
      EventEmitter.call(self);
      self.reader = reader;
      self.reader.on("error", function(err) {
        emitError(self, err);
      });
      self.reader.once("close", function() {
        self.emit("close");
      });
      self.readEntryCursor = centralDirectoryOffset;
      self.fileSize = fileSize;
      self.entryCount = entryCount;
      self.comment = comment;
      self.entriesRead = 0;
      self.autoClose = !!autoClose;
      self.lazyEntries = !!lazyEntries;
      self.decodeStrings = !!decodeStrings;
      self.validateEntrySizes = !!validateEntrySizes;
      self.strictFileNames = !!strictFileNames;
      self.isOpen = true;
      self.emittedError = false;
      if (!self.lazyEntries) self._readEntry();
    }
    ZipFile.prototype.close = function() {
      if (!this.isOpen) return;
      this.isOpen = false;
      this.reader.unref();
    };
    function emitErrorAndAutoClose(self, err) {
      if (self.autoClose) self.close();
      emitError(self, err);
    }
    function emitError(self, err) {
      if (self.emittedError) return;
      self.emittedError = true;
      self.emit("error", err);
    }
    ZipFile.prototype.readEntry = function() {
      if (!this.lazyEntries) throw new Error("readEntry() called without lazyEntries:true");
      this._readEntry();
    };
    ZipFile.prototype._readEntry = function() {
      var self = this;
      if (self.entryCount === self.entriesRead) {
        setImmediate(function() {
          if (self.autoClose) self.close();
          if (self.emittedError) return;
          self.emit("end");
        });
        return;
      }
      if (self.emittedError) return;
      var buffer = newBuffer(46);
      readAndAssertNoEof(self.reader, buffer, 0, buffer.length, self.readEntryCursor, function(err) {
        if (err) return emitErrorAndAutoClose(self, err);
        if (self.emittedError) return;
        var entry = new Entry();
        var signature = buffer.readUInt32LE(0);
        if (signature !== 33639248) return emitErrorAndAutoClose(self, new Error("invalid central directory file header signature: 0x" + signature.toString(16)));
        entry.versionMadeBy = buffer.readUInt16LE(4);
        entry.versionNeededToExtract = buffer.readUInt16LE(6);
        entry.generalPurposeBitFlag = buffer.readUInt16LE(8);
        entry.compressionMethod = buffer.readUInt16LE(10);
        entry.lastModFileTime = buffer.readUInt16LE(12);
        entry.lastModFileDate = buffer.readUInt16LE(14);
        entry.crc32 = buffer.readUInt32LE(16);
        entry.compressedSize = buffer.readUInt32LE(20);
        entry.uncompressedSize = buffer.readUInt32LE(24);
        entry.fileNameLength = buffer.readUInt16LE(28);
        entry.extraFieldLength = buffer.readUInt16LE(30);
        entry.fileCommentLength = buffer.readUInt16LE(32);
        entry.internalFileAttributes = buffer.readUInt16LE(36);
        entry.externalFileAttributes = buffer.readUInt32LE(38);
        entry.relativeOffsetOfLocalHeader = buffer.readUInt32LE(42);
        if (entry.generalPurposeBitFlag & 64) return emitErrorAndAutoClose(self, new Error("strong encryption is not supported"));
        self.readEntryCursor += 46;
        buffer = newBuffer(entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength);
        readAndAssertNoEof(self.reader, buffer, 0, buffer.length, self.readEntryCursor, function(err2) {
          if (err2) return emitErrorAndAutoClose(self, err2);
          if (self.emittedError) return;
          var isUtf8 = (entry.generalPurposeBitFlag & 2048) !== 0;
          entry.fileName = self.decodeStrings ? decodeBuffer(buffer, 0, entry.fileNameLength, isUtf8) : buffer.slice(0, entry.fileNameLength);
          var fileCommentStart = entry.fileNameLength + entry.extraFieldLength;
          var extraFieldBuffer = buffer.slice(entry.fileNameLength, fileCommentStart);
          entry.extraFields = [];
          var i = 0;
          while (i < extraFieldBuffer.length - 3) {
            var headerId = extraFieldBuffer.readUInt16LE(i + 0);
            var dataSize = extraFieldBuffer.readUInt16LE(i + 2);
            var dataStart = i + 4;
            var dataEnd = dataStart + dataSize;
            if (dataEnd > extraFieldBuffer.length) return emitErrorAndAutoClose(self, new Error("extra field length exceeds extra field buffer size"));
            var dataBuffer = newBuffer(dataSize);
            extraFieldBuffer.copy(dataBuffer, 0, dataStart, dataEnd);
            entry.extraFields.push({
              id: headerId,
              data: dataBuffer
            });
            i = dataEnd;
          }
          entry.fileComment = self.decodeStrings ? decodeBuffer(buffer, fileCommentStart, fileCommentStart + entry.fileCommentLength, isUtf8) : buffer.slice(fileCommentStart, fileCommentStart + entry.fileCommentLength);
          entry.comment = entry.fileComment;
          self.readEntryCursor += buffer.length;
          self.entriesRead += 1;
          if (entry.uncompressedSize === 4294967295 || entry.compressedSize === 4294967295 || entry.relativeOffsetOfLocalHeader === 4294967295) {
            var zip64EiefBuffer = null;
            for (var i = 0; i < entry.extraFields.length; i++) {
              var extraField = entry.extraFields[i];
              if (extraField.id === 1) {
                zip64EiefBuffer = extraField.data;
                break;
              }
            }
            if (zip64EiefBuffer == null) {
              return emitErrorAndAutoClose(self, new Error("expected zip64 extended information extra field"));
            }
            var index = 0;
            if (entry.uncompressedSize === 4294967295) {
              if (index + 8 > zip64EiefBuffer.length) {
                return emitErrorAndAutoClose(self, new Error("zip64 extended information extra field does not include uncompressed size"));
              }
              entry.uncompressedSize = readUInt64LE(zip64EiefBuffer, index);
              index += 8;
            }
            if (entry.compressedSize === 4294967295) {
              if (index + 8 > zip64EiefBuffer.length) {
                return emitErrorAndAutoClose(self, new Error("zip64 extended information extra field does not include compressed size"));
              }
              entry.compressedSize = readUInt64LE(zip64EiefBuffer, index);
              index += 8;
            }
            if (entry.relativeOffsetOfLocalHeader === 4294967295) {
              if (index + 8 > zip64EiefBuffer.length) {
                return emitErrorAndAutoClose(self, new Error("zip64 extended information extra field does not include relative header offset"));
              }
              entry.relativeOffsetOfLocalHeader = readUInt64LE(zip64EiefBuffer, index);
              index += 8;
            }
          }
          if (self.decodeStrings) {
            for (var i = 0; i < entry.extraFields.length; i++) {
              var extraField = entry.extraFields[i];
              if (extraField.id === 28789) {
                if (extraField.data.length < 6) {
                  continue;
                }
                if (extraField.data.readUInt8(0) !== 1) {
                  continue;
                }
                var oldNameCrc32 = extraField.data.readUInt32LE(1);
                if (crc32.unsigned(buffer.slice(0, entry.fileNameLength)) !== oldNameCrc32) {
                  continue;
                }
                entry.fileName = decodeBuffer(extraField.data, 5, extraField.data.length, true);
                break;
              }
            }
          }
          if (self.validateEntrySizes && entry.compressionMethod === 0) {
            var expectedCompressedSize = entry.uncompressedSize;
            if (entry.isEncrypted()) {
              expectedCompressedSize += 12;
            }
            if (entry.compressedSize !== expectedCompressedSize) {
              var msg = "compressed/uncompressed size mismatch for stored file: " + entry.compressedSize + " != " + entry.uncompressedSize;
              return emitErrorAndAutoClose(self, new Error(msg));
            }
          }
          if (self.decodeStrings) {
            if (!self.strictFileNames) {
              entry.fileName = entry.fileName.replace(/\\/g, "/");
            }
            var errorMessage = validateFileName(entry.fileName, self.validateFileNameOptions);
            if (errorMessage != null) return emitErrorAndAutoClose(self, new Error(errorMessage));
          }
          self.emit("entry", entry);
          if (!self.lazyEntries) self._readEntry();
        });
      });
    };
    ZipFile.prototype.openReadStream = function(entry, options, callback) {
      var self = this;
      var relativeStart = 0;
      var relativeEnd = entry.compressedSize;
      if (callback == null) {
        callback = options;
        options = {};
      } else {
        if (options.decrypt != null) {
          if (!entry.isEncrypted()) {
            throw new Error("options.decrypt can only be specified for encrypted entries");
          }
          if (options.decrypt !== false) throw new Error("invalid options.decrypt value: " + options.decrypt);
          if (entry.isCompressed()) {
            if (options.decompress !== false) throw new Error("entry is encrypted and compressed, and options.decompress !== false");
          }
        }
        if (options.decompress != null) {
          if (!entry.isCompressed()) {
            throw new Error("options.decompress can only be specified for compressed entries");
          }
          if (!(options.decompress === false || options.decompress === true)) {
            throw new Error("invalid options.decompress value: " + options.decompress);
          }
        }
        if (options.start != null || options.end != null) {
          if (entry.isCompressed() && options.decompress !== false) {
            throw new Error("start/end range not allowed for compressed entry without options.decompress === false");
          }
          if (entry.isEncrypted() && options.decrypt !== false) {
            throw new Error("start/end range not allowed for encrypted entry without options.decrypt === false");
          }
        }
        if (options.start != null) {
          relativeStart = options.start;
          if (relativeStart < 0) throw new Error("options.start < 0");
          if (relativeStart > entry.compressedSize) throw new Error("options.start > entry.compressedSize");
        }
        if (options.end != null) {
          relativeEnd = options.end;
          if (relativeEnd < 0) throw new Error("options.end < 0");
          if (relativeEnd > entry.compressedSize) throw new Error("options.end > entry.compressedSize");
          if (relativeEnd < relativeStart) throw new Error("options.end < options.start");
        }
      }
      if (!self.isOpen) return callback(new Error("closed"));
      if (entry.isEncrypted()) {
        if (options.decrypt !== false) return callback(new Error("entry is encrypted, and options.decrypt !== false"));
      }
      self.reader.ref();
      var buffer = newBuffer(30);
      readAndAssertNoEof(self.reader, buffer, 0, buffer.length, entry.relativeOffsetOfLocalHeader, function(err) {
        try {
          if (err) return callback(err);
          var signature = buffer.readUInt32LE(0);
          if (signature !== 67324752) {
            return callback(new Error("invalid local file header signature: 0x" + signature.toString(16)));
          }
          var fileNameLength = buffer.readUInt16LE(26);
          var extraFieldLength = buffer.readUInt16LE(28);
          var localFileHeaderEnd = entry.relativeOffsetOfLocalHeader + buffer.length + fileNameLength + extraFieldLength;
          var decompress;
          if (entry.compressionMethod === 0) {
            decompress = false;
          } else if (entry.compressionMethod === 8) {
            decompress = options.decompress != null ? options.decompress : true;
          } else {
            return callback(new Error("unsupported compression method: " + entry.compressionMethod));
          }
          var fileDataStart = localFileHeaderEnd;
          var fileDataEnd = fileDataStart + entry.compressedSize;
          if (entry.compressedSize !== 0) {
            if (fileDataEnd > self.fileSize) {
              return callback(new Error("file data overflows file bounds: " + fileDataStart + " + " + entry.compressedSize + " > " + self.fileSize));
            }
          }
          var readStream = self.reader.createReadStream({
            start: fileDataStart + relativeStart,
            end: fileDataStart + relativeEnd
          });
          var endpointStream = readStream;
          if (decompress) {
            var destroyed = false;
            var inflateFilter = zlib.createInflateRaw();
            readStream.on("error", function(err2) {
              setImmediate(function() {
                if (!destroyed) inflateFilter.emit("error", err2);
              });
            });
            readStream.pipe(inflateFilter);
            if (self.validateEntrySizes) {
              endpointStream = new AssertByteCountStream(entry.uncompressedSize);
              inflateFilter.on("error", function(err2) {
                setImmediate(function() {
                  if (!destroyed) endpointStream.emit("error", err2);
                });
              });
              inflateFilter.pipe(endpointStream);
            } else {
              endpointStream = inflateFilter;
            }
            endpointStream.destroy = function() {
              destroyed = true;
              if (inflateFilter !== endpointStream) inflateFilter.unpipe(endpointStream);
              readStream.unpipe(inflateFilter);
              readStream.destroy();
            };
          }
          callback(null, endpointStream);
        } finally {
          self.reader.unref();
        }
      });
    };
    function Entry() {
    }
    Entry.prototype.getLastModDate = function() {
      return dosDateTimeToDate(this.lastModFileDate, this.lastModFileTime);
    };
    Entry.prototype.isEncrypted = function() {
      return (this.generalPurposeBitFlag & 1) !== 0;
    };
    Entry.prototype.isCompressed = function() {
      return this.compressionMethod === 8;
    };
    function dosDateTimeToDate(date, time) {
      var day = date & 31;
      var month = (date >> 5 & 15) - 1;
      var year = (date >> 9 & 127) + 1980;
      var millisecond = 0;
      var second = (time & 31) * 2;
      var minute = time >> 5 & 63;
      var hour = time >> 11 & 31;
      return new Date(year, month, day, hour, minute, second, millisecond);
    }
    function validateFileName(fileName) {
      if (fileName.indexOf("\\") !== -1) {
        return "invalid characters in fileName: " + fileName;
      }
      if (/^[a-zA-Z]:/.test(fileName) || /^\//.test(fileName)) {
        return "absolute path: " + fileName;
      }
      if (fileName.split("/").indexOf("..") !== -1) {
        return "invalid relative path: " + fileName;
      }
      return null;
    }
    function readAndAssertNoEof(reader, buffer, offset, length, position, callback) {
      if (length === 0) {
        return setImmediate(function() {
          callback(null, newBuffer(0));
        });
      }
      reader.read(buffer, offset, length, position, function(err, bytesRead) {
        if (err) return callback(err);
        if (bytesRead < length) {
          return callback(new Error("unexpected EOF"));
        }
        callback();
      });
    }
    util.inherits(AssertByteCountStream, Transform);
    function AssertByteCountStream(byteCount) {
      Transform.call(this);
      this.actualByteCount = 0;
      this.expectedByteCount = byteCount;
    }
    AssertByteCountStream.prototype._transform = function(chunk, encoding, cb) {
      this.actualByteCount += chunk.length;
      if (this.actualByteCount > this.expectedByteCount) {
        var msg = "too many bytes in the stream. expected " + this.expectedByteCount + ". got at least " + this.actualByteCount;
        return cb(new Error(msg));
      }
      cb(null, chunk);
    };
    AssertByteCountStream.prototype._flush = function(cb) {
      if (this.actualByteCount < this.expectedByteCount) {
        var msg = "not enough bytes in the stream. expected " + this.expectedByteCount + ". got only " + this.actualByteCount;
        return cb(new Error(msg));
      }
      cb();
    };
    util.inherits(RandomAccessReader, EventEmitter);
    function RandomAccessReader() {
      EventEmitter.call(this);
      this.refCount = 0;
    }
    RandomAccessReader.prototype.ref = function() {
      this.refCount += 1;
    };
    RandomAccessReader.prototype.unref = function() {
      var self = this;
      self.refCount -= 1;
      if (self.refCount > 0) return;
      if (self.refCount < 0) throw new Error("invalid unref");
      self.close(onCloseDone);
      function onCloseDone(err) {
        if (err) return self.emit("error", err);
        self.emit("close");
      }
    };
    RandomAccessReader.prototype.createReadStream = function(options) {
      var start = options.start;
      var end = options.end;
      if (start === end) {
        var emptyStream = new PassThrough();
        setImmediate(function() {
          emptyStream.end();
        });
        return emptyStream;
      }
      var stream = this._readStreamForRange(start, end);
      var destroyed = false;
      var refUnrefFilter = new RefUnrefFilter(this);
      stream.on("error", function(err) {
        setImmediate(function() {
          if (!destroyed) refUnrefFilter.emit("error", err);
        });
      });
      refUnrefFilter.destroy = function() {
        stream.unpipe(refUnrefFilter);
        refUnrefFilter.unref();
        stream.destroy();
      };
      var byteCounter = new AssertByteCountStream(end - start);
      refUnrefFilter.on("error", function(err) {
        setImmediate(function() {
          if (!destroyed) byteCounter.emit("error", err);
        });
      });
      byteCounter.destroy = function() {
        destroyed = true;
        refUnrefFilter.unpipe(byteCounter);
        refUnrefFilter.destroy();
      };
      return stream.pipe(refUnrefFilter).pipe(byteCounter);
    };
    RandomAccessReader.prototype._readStreamForRange = function(start, end) {
      throw new Error("not implemented");
    };
    RandomAccessReader.prototype.read = function(buffer, offset, length, position, callback) {
      var readStream = this.createReadStream({ start: position, end: position + length });
      var writeStream = new Writable();
      var written = 0;
      writeStream._write = function(chunk, encoding, cb) {
        chunk.copy(buffer, offset + written, 0, chunk.length);
        written += chunk.length;
        cb();
      };
      writeStream.on("finish", callback);
      readStream.on("error", function(error) {
        callback(error);
      });
      readStream.pipe(writeStream);
    };
    RandomAccessReader.prototype.close = function(callback) {
      setImmediate(callback);
    };
    util.inherits(RefUnrefFilter, PassThrough);
    function RefUnrefFilter(context) {
      PassThrough.call(this);
      this.context = context;
      this.context.ref();
      this.unreffedYet = false;
    }
    RefUnrefFilter.prototype._flush = function(cb) {
      this.unref();
      cb();
    };
    RefUnrefFilter.prototype.unref = function(cb) {
      if (this.unreffedYet) return;
      this.unreffedYet = true;
      this.context.unref();
    };
    var cp437 = "\0\u263A\u263B\u2665\u2666\u2663\u2660\u2022\u25D8\u25CB\u25D9\u2642\u2640\u266A\u266B\u263C\u25BA\u25C4\u2195\u203C\xB6\xA7\u25AC\u21A8\u2191\u2193\u2192\u2190\u221F\u2194\u25B2\u25BC !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\u2302\xC7\xFC\xE9\xE2\xE4\xE0\xE5\xE7\xEA\xEB\xE8\xEF\xEE\xEC\xC4\xC5\xC9\xE6\xC6\xF4\xF6\xF2\xFB\xF9\xFF\xD6\xDC\xA2\xA3\xA5\u20A7\u0192\xE1\xED\xF3\xFA\xF1\xD1\xAA\xBA\xBF\u2310\xAC\xBD\xBC\xA1\xAB\xBB\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255D\u255C\u255B\u2510\u2514\u2534\u252C\u251C\u2500\u253C\u255E\u255F\u255A\u2554\u2569\u2566\u2560\u2550\u256C\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256B\u256A\u2518\u250C\u2588\u2584\u258C\u2590\u2580\u03B1\xDF\u0393\u03C0\u03A3\u03C3\xB5\u03C4\u03A6\u0398\u03A9\u03B4\u221E\u03C6\u03B5\u2229\u2261\xB1\u2265\u2264\u2320\u2321\xF7\u2248\xB0\u2219\xB7\u221A\u207F\xB2\u25A0\xA0";
    function decodeBuffer(buffer, start, end, isUtf8) {
      if (isUtf8) {
        return buffer.toString("utf8", start, end);
      } else {
        var result = "";
        for (var i = start; i < end; i++) {
          result += cp437[buffer[i]];
        }
        return result;
      }
    }
    function readUInt64LE(buffer, offset) {
      var lower32 = buffer.readUInt32LE(offset);
      var upper32 = buffer.readUInt32LE(offset + 4);
      return upper32 * 4294967296 + lower32;
    }
    var newBuffer;
    if (typeof Buffer.allocUnsafe === "function") {
      newBuffer = function(len) {
        return Buffer.allocUnsafe(len);
      };
    } else {
      newBuffer = function(len) {
        return new Buffer(len);
      };
    }
    function defaultCallback(err) {
      if (err) throw err;
    }
  }
});

// node_modules/word-extractor/lib/buffer-reader.js
var require_buffer_reader = __commonJS({
  "node_modules/word-extractor/lib/buffer-reader.js"(exports2, module2) {
    var BufferReader = class _BufferReader {
      constructor(buffer) {
        this._buffer = buffer;
      }
      open() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
      read(buffer, offset, length, position) {
        this._buffer.copy(buffer, offset, position, position + length);
        return Promise.resolve(buffer);
      }
      buffer() {
        return this._buffer;
      }
      static isBufferReader(instance) {
        return instance instanceof _BufferReader;
      }
    };
    module2.exports = BufferReader;
  }
});

// node_modules/word-extractor/lib/file-reader.js
var require_file_reader = __commonJS({
  "node_modules/word-extractor/lib/file-reader.js"(exports2, module2) {
    var fs = require("fs");
    var FileReader = class _FileReader {
      /**
       * Creates a new file reader instance, using the given filename.
       * @param {*} filename 
       */
      constructor(filename) {
        this._filename = filename;
      }
      /**
       * Opens the file descriptor for a file, and returns a promise that resolves
       * when the file is open. After this, {@link FileReader#read} can be called 
       * to read file content into a buffer.
       * @returns a promise
       */
      open() {
        return new Promise((resolve, reject) => {
          fs.open(this._filename, "r", 438, (err, fd) => {
            if (err) {
              return reject(err);
            }
            this._fd = fd;
            resolve();
          });
        });
      }
      /**
       * Closes the file descriptor associated with an open document, if there
       * is one, and returns a promise that resolves when the file handle is closed.
       * @returns a promise
       */
      close() {
        return new Promise((resolve, reject) => {
          if (this._fd) {
            fs.close(this._fd, (err) => {
              if (err) {
                return reject(err);
              }
              delete this._fd;
              resolve();
            });
          } else {
            resolve();
          }
        });
      }
      /**
       * Reads a buffer of `length` bytes into the `buffer`. The new data will
       * be added to the buffer at offset `offset`, and will be read from the
       * file starting at position `position`
       * @param {*} buffer 
       * @param {*} offset 
       * @param {*} length 
       * @param {*} position 
       * @returns a promise that resolves to the buffer when the data is present
       */
      read(buffer, offset, length, position) {
        return new Promise((resolve, reject) => {
          if (!this._fd) {
            return reject(new Error("file not open"));
          }
          fs.read(this._fd, buffer, offset, length, position, (err, bytesRead, buffer2) => {
            if (err) {
              return reject(err);
            }
            resolve(buffer2);
          });
        });
      }
      /**
       * Returns the open file descriptor
       * @returns the file descriptor
       */
      fd() {
        return this._fd;
      }
      /**
       * Returns true if the passed instance is an instance of this class.
       * @param {*} instance 
       * @returns true if `instance` is an instance of {@link FileReader}.
       */
      static isFileReader(instance) {
        return instance instanceof _FileReader;
      }
    };
    module2.exports = FileReader;
  }
});

// node_modules/word-extractor/lib/open-office-extractor.js
var require_open_office_extractor = __commonJS({
  "node_modules/word-extractor/lib/open-office-extractor.js"(exports2, module2) {
    var path = require("path");
    var SAXES = require_saxes();
    var yauzl = require_yauzl();
    var BufferReader = require_buffer_reader();
    var FileReader = require_file_reader();
    var Document = require_document();
    function each(callback, array, index) {
      if (index === array.length) {
        return Promise.resolve();
      } else {
        return Promise.resolve(callback(array[index++])).then(() => each(callback, array, index));
      }
    }
    var OpenOfficeExtractor = class {
      constructor() {
        this._streamTypes = {
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml": true,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml": true,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml": true,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml": true,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml": true,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml": true,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml": true,
          "application/vnd.openxmlformats-package.relationships+xml": true
        };
        this._headerTypes = {
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header": true,
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer": true
        };
        this._actions = {};
        this._defaults = {};
      }
      shouldProcess(filename) {
        if (this._actions[filename]) {
          return true;
        }
        const extension = path.posix.extname(filename).replace(/^\./, "");
        if (!extension) {
          return false;
        }
        const defaultType = this._defaults[extension];
        if (defaultType && this._streamTypes[defaultType]) {
          return true;
        }
        return false;
      }
      openArchive(reader) {
        if (BufferReader.isBufferReader(reader)) {
          return new Promise((resolve, reject) => {
            yauzl.fromBuffer(reader.buffer(), { lazyEntries: true }, function(err, zipfile) {
              if (err) {
                return reject(err);
              }
              resolve(zipfile);
            });
          });
        } else if (FileReader.isFileReader(reader)) {
          return new Promise((resolve, reject) => {
            yauzl.fromFd(reader.fd(), { lazyEntries: true, autoClose: false }, function(err, zipfile) {
              if (err) {
                return reject(err);
              }
              resolve(zipfile);
            });
          });
        } else {
          throw new Error("Unexpected reader type: " + reader.constructor.name);
        }
      }
      processEntries(zipfile) {
        let entryTable = {};
        let entryNames = [];
        return new Promise((resolve, reject) => {
          zipfile.readEntry();
          zipfile.on("error", reject);
          zipfile.on("entry", (entry) => {
            const filename = entry.fileName;
            entryTable[filename] = entry;
            entryNames.push(filename);
            zipfile.readEntry();
          });
          zipfile.on("end", () => resolve(this._document));
        }).then(() => {
          const index = entryNames.indexOf("[Content_Types].xml");
          if (index === -1) {
            throw new Error("Invalid Open Office XML: missing content types");
          }
          entryNames.splice(index, 1);
          entryNames.unshift("[Content_Types].xml");
          this._actions["[Content_Types].xml"] = true;
          return each((name) => {
            if (this.shouldProcess(name)) {
              return this.handleEntry(zipfile, entryTable[name]);
            }
          }, entryNames, 0);
        });
      }
      extract(reader) {
        let archive = this.openArchive(reader);
        this._document = new Document();
        this._relationships = {};
        this._entryTable = {};
        this._entries = [];
        return archive.then((zipfile) => this.processEntries(zipfile)).then(() => {
          let document = this._document;
          if (document._textboxes && document._textboxes.length > 0) {
            document._textboxes = document._textboxes + "\n";
          }
          if (document._headerTextboxes && document._headerTextboxes.length > 0) {
            document._headerTextboxes = document._headerTextboxes + "\n";
          }
          return document;
        });
      }
      handleOpenTag(node) {
        if (node.name === "Override") {
          const actionFunction = this._streamTypes[node.attributes["ContentType"]];
          if (actionFunction) {
            const partName = node.attributes["PartName"].replace(/^[/]+/, "");
            const action = { action: actionFunction, type: node.attributes["ContentType"] };
            this._actions[partName] = action;
          }
        } else if (node.name === "Default") {
          const extension = node.attributes["Extension"];
          const contentType = node.attributes["ContentType"];
          this._defaults[extension] = contentType;
        } else if (node.name === "Relationship") {
          this._relationships[node.attributes["Id"]] = {
            type: node.attributes["Type"],
            target: node.attributes["Target"]
          };
        } else if (node.name === "w:document" || node.name === "w:footnotes" || node.name === "w:endnotes" || node.name === "w:comments") {
          this._context = ["content", "body"];
          this._pieces = [];
        } else if (node.name === "w:hdr" || node.name === "w:ftr") {
          this._context = ["content", "header"];
          this._pieces = [];
        } else if (node.name === "w:endnote" || node.name === "w:footnote") {
          const type = node.attributes["w:type"] || this._context[0];
          this._context.unshift(type);
        } else if (node.name === "w:tab" && this._context[0] === "content") {
          this._pieces.push("	");
        } else if (node.name === "w:br" && this._context[0] === "content") {
          if ((node.attributes["w:type"] || "") === "page") {
            this._pieces.push("\n");
          } else {
            this._pieces.push("\n");
          }
        } else if (node.name === "w:del" || node.name === "w:instrText") {
          this._context.unshift("deleted");
        } else if (node.name === "w:tabs") {
          this._context.unshift("tabs");
        } else if (node.name === "w:tc") {
          this._context.unshift("cell");
        } else if (node.name === "w:drawing") {
          this._context.unshift("drawing");
        } else if (node.name === "w:txbxContent") {
          this._context.unshift(this._pieces);
          this._context.unshift("textbox");
          this._pieces = [];
        }
      }
      handleCloseTag(node) {
        if (node.name === "w:document") {
          this._context = null;
          this._document._body = this._pieces.join("");
        } else if (node.name === "w:footnote" || node.name === "w:endnote") {
          this._context.shift();
        } else if (node.name === "w:footnotes") {
          this._context = null;
          this._document._footnotes = this._pieces.join("");
        } else if (node.name === "w:endnotes") {
          this._context = null;
          this._document._endnotes = this._pieces.join("");
        } else if (node.name === "w:comments") {
          this._context = null;
          this._document._annotations = this._pieces.join("");
        } else if (node.name === "w:hdr") {
          this._context = null;
          this._document._headers = this._document._headers + this._pieces.join("");
        } else if (node.name === "w:ftr") {
          this._context = null;
          this._document._footers = this._document._footers + this._pieces.join("");
        } else if (node.name === "w:p") {
          if (this._context[0] === "content" || this._context[0] === "cell" || this._context[0] === "textbox") {
            this._pieces.push("\n");
          }
        } else if (node.name === "w:del" || node.name === "w:instrText") {
          this._context.shift();
        } else if (node.name === "w:tabs") {
          this._context.shift();
        } else if (node.name === "w:tc") {
          this._pieces.pop();
          this._pieces.push("	");
          this._context.shift();
        } else if (node.name === "w:tr") {
          this._pieces.push("\n");
        } else if (node.name === "w:drawing") {
          this._context.shift();
        } else if (node.name === "w:txbxContent") {
          const textBox = this._pieces.join("");
          const context = this._context.shift();
          if (context !== "textbox") {
            throw new Error("Invalid textbox context");
          }
          this._pieces = this._context.shift();
          if (this._context[0] === "drawing")
            return;
          if (textBox.length == 0)
            return;
          const inHeader = this._context.includes("header");
          const documentField = inHeader ? "_headerTextboxes" : "_textboxes";
          if (this._document[documentField]) {
            this._document[documentField] = this._document[documentField] + "\n" + textBox;
          } else {
            this._document[documentField] = textBox;
          }
        }
      }
      createXmlParser() {
        const parser = new SAXES.SaxesParser();
        parser.on("opentag", (node) => {
          try {
            this.handleOpenTag(node);
          } catch (e) {
            parser.fail(e.message);
          }
        });
        parser.on("closetag", (node) => {
          try {
            this.handleCloseTag(node);
          } catch (e) {
            parser.fail(e.message);
          }
        });
        parser.on("text", (string) => {
          try {
            if (!this._context)
              return;
            if (this._context[0] === "content" || this._context[0] === "cell" || this._context[0] === "textbox") {
              this._pieces.push(string);
            }
          } catch (e) {
            parser.fail(e.message);
          }
        });
        return parser;
      }
      handleEntry(zipfile, entry) {
        return new Promise((resolve, reject) => {
          zipfile.openReadStream(entry, (err, readStream) => {
            if (err) {
              return reject(err);
            }
            this._source = entry.fileName;
            const parser = this.createXmlParser();
            parser.on("error", (e) => {
              readStream.destroy(e);
              reject(e);
            });
            parser.on("end", () => resolve());
            readStream.on("end", () => parser.close());
            readStream.on("error", (e) => reject(e));
            readStream.on("readable", () => {
              while (true) {
                const chunk = readStream.read(4096);
                if (chunk === null) {
                  return;
                }
                parser.write(chunk);
              }
            });
          });
        });
      }
    };
    module2.exports = OpenOfficeExtractor;
  }
});

// node_modules/word-extractor/lib/word.js
var require_word = __commonJS({
  "node_modules/word-extractor/lib/word.js"(exports2, module2) {
    var { Buffer: Buffer2 } = require("buffer");
    var WordOleExtractor = require_word_ole_extractor();
    var OpenOfficeExtractor = require_open_office_extractor();
    var BufferReader = require_buffer_reader();
    var FileReader = require_file_reader();
    var WordExtractor = class {
      constructor() {
      }
      /**
       * Extracts the main contents of the file. If a Buffer is passed, that
       * is used instead. Opens the file, and reads the first block, uses that
       * to detect whether this is a .doc file or a .docx file, and then calls
       * either {@link WordOleDocument#extract} or {@link OpenOfficeDocument#extract}
       * accordingly.
       * 
       * @param {string|Buffer} source - either a string filename, or a Buffer containing the file content
       * @returns a {@link Document} providing accessors onto the text
       */
      extract(source) {
        let reader = null;
        if (Buffer2.isBuffer(source)) {
          reader = new BufferReader(source);
        } else if (typeof source === "string") {
          reader = new FileReader(source);
        }
        const buffer = Buffer2.alloc(512);
        return reader.open().then(() => reader.read(buffer, 0, 512, 0)).then((buffer2) => {
          let extractor = null;
          if (buffer2.readUInt16BE(0) === 53455) {
            extractor = WordOleExtractor;
          } else if (buffer2.readUInt16BE(0) === 20555) {
            const next = buffer2.readUInt16BE(2);
            if (next === 772 || next === 1286 || next === 1800) {
              extractor = OpenOfficeExtractor;
            }
          }
          if (!extractor) {
            throw new Error("Unable to read this type of file");
          }
          return new extractor().extract(reader);
        }).finally(() => reader.close());
      }
    };
    module2.exports = WordExtractor;
  }
});

// entry.js
module.exports = require_word();
/*! Bundled license information:

xmlchars/xml/1.0/ed5.js:
  (**
   * Character classes and associated utilities for the 5th edition of XML 1.0.
   *
   * @author Louis-Dominique Dubeau
   * @license MIT
   * @copyright Louis-Dominique Dubeau
   *)

xmlchars/xml/1.1/ed2.js:
  (**
   * Character classes and associated utilities for the 2nd edition of XML 1.1.
   *
   * @author Louis-Dominique Dubeau
   * @license MIT
   * @copyright Louis-Dominique Dubeau
   *)

xmlchars/xmlns/1.0/ed3.js:
  (**
   * Character class utilities for XML NS 1.0 edition 3.
   *
   * @author Louis-Dominique Dubeau
   * @license MIT
   * @copyright Louis-Dominique Dubeau
   *)
*/
