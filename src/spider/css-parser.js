/* global require,module,console */

'use strict';

var path = require('path');
var crypto = require('crypto');
var utils = require('./utils');
var CSSOM = require('cssom');
var Resource = require('./resource');
var Promise = require('./promise');
var VError = require('verror');




function CssParser (resource) {

    if (resource instanceof Promise) {
        return resource.then(function (resource) {
            return new CssParser(resource);
        });
    }


    if (!(resource instanceof Resource.Model)) {
        throw new Error('require `Resource.Model`');
    }


    var file = resource.file;
    var content = resource.content;
    var options = resource.options;
    var cache = options.cache;
    var cssParser;


    if (cache) {
        cssParser = CssParser.cache[file];
        if (cssParser) {
            // 深拷贝缓存
            return cssParser.then(utils.copy);
        }
    }

    var ast;

    // CSSOM BUG?
    content = content.replace(/@charset\b.+;/g, '');

    try {
        ast = CSSOM.parse(content);
    } catch (errors) {
        
        errors = new VError(errors, 'parse "%s" failed', file);
        return Promise.reject(errors);
    }

    cssParser = new CssParser.Parser(ast, file, options);

    if (cache) {
        CssParser.cache[file] = cssParser;
    }

    return cssParser;
}





CssParser.Model = function (type) {

    // {String} 类型：CSSFontFaceRule | CSSStyleRule
    this.type = type;

    // {String, Array} 字体 ID
    this.id = null;

    // {String, Array} 字体名
    this.family = null;

    // {String} 字体绝对路径
    this.files = null;

    // {Array} 使用了改字体的选择器信息
    this.selectors = null;

    // {Array} 字体使用的字符（包括 content 属性）
    this.chars = null;

    // {Object} 字体相关选项 @see getFontId.keys
    this.options = null;

};

CssParser.Model.prototype.mix = function (object) {
    utils.mix(this, object);
    return this;
};





CssParser.cache = {};



/*
 * 默认选项
 */
CssParser.defaults = {
    cache: true,        // 缓存开关
    ignore: [],         // 忽略的文件配置
    map: []             // 文件映射配置
};





CssParser.Parser = function Parser (ast, file, options) {

    options = utils.options(CssParser.defaults, options);

    var that = this;
    var tasks = [];

    this.options = options;
    this.base = path.dirname(file);
    this.file = file;


    // 忽略文件
    this.filter = utils.filter(options.ignore);

    // 对文件地址进行映射
    this.map = utils.map(options.map);


    ast.cssRules.forEach(function (rule) {
        var type = rule.constructor.name;
        var ret;

        if (typeof that[type] === 'function') {

            try {
                ret = that[type](rule);
            } catch (errors) {
                // debug
                console.error('DEBUG', type, errors.stack);
            }

            if (ret) {
                tasks.push(ret);
            }
        }
    });


    var promise = Promise.all(tasks)
    .then(function (list) {
        
        var ret = [];
        list.forEach(function (item) {
            if (Array.isArray(item)) {
                ret = ret.concat(item);
            } else if (item instanceof CssParser.Model) {
                ret.push(item);
            }
        });

        return ret;
    });


    return promise;
};





utils.mix(CssParser.Parser.prototype, {


    // 最大 @import 文件数量限制
    maxFilesLength: 15,


    // CSS 导入规则
    // @import url("fineprint.css") print;
    // @import url("bluish.css") projection, tv;
    // @import 'custom.css';
    // @import url("chrome://communicator/skin/");
    // @import "common.css" screen, projection;
    // @import url('landscape.css') screen and (orientation:landscape);
    CSSImportRule: function (rule) {

        var that = this;
        var base = this.base;
        var options = this.options;
        var url = utils.unquotation(rule.href.trim());
        url = utils.resolve(base, url);
        url = this.filter(url);
        url = this.map(url);
        url = utils.normalize(url);


        if (!url) {
            return;
        }


        if (typeof options._maxFilesLength !== 'number') {
            options._maxFilesLength = 0;
        }


        options._maxFilesLength ++;


        // 限制导入的样式数量，避免让爬虫进入死循环陷阱
        if (options._maxFilesLength > this.maxFilesLength) {
            var errors = new Error('the number of files imported exceeds the maximum limit');
            errors = new VError(errors, 'parse "%s" failed', that.file);
            return Promise.reject(errors);
        }


        return new CssParser(
            new Resource(url, null, options)
            .catch(function (errors) {
                errors = new VError(errors, 'parse "%s" failed', that.file);
                return Promise.reject(errors);
            }
        ));
    },


    // webfont 规则
    // @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face
    CSSFontFaceRule: function (rule) {
        var base = this.base;
        var files = [];
        var family = utils.unquotation(rule.style['font-family']);

        var model = new CssParser.Model('CSSFontFaceRule').mix({
            id: null,
            family: family,
            files: files,
            selectors: [],
            chars: [],
            options: {}
        });


        // 复制 font 相关规则
        getFontId.keys.forEach(function (key, index) {
            var value = rule.style[key];

            if (typeof value !== 'string') {
                value = getFontId.values[index];
            }

            model.options[key] = value;
        });

        model.id = getFontId(family, model.options);

        
        var urls = utils.urlToArray(rule.style.src);
        urls = urls.map(function (file) {
            file = utils.resolve(base, file);
            return utils.normalize(file);
        });

        urls = this.filter(urls);
        urls = this.map(urls);

        files.push.apply(files, urls);

        return model;
    },


    // 选择器规则
    CSSStyleRule: function (rule) {

        var selectorText = rule.selectorText;
        var fontFamily = rule.style['font-family'];
        var content = utils.unquotation(rule.style.content || '');

        if (!fontFamily) {
            return;
        }

        var model = new CssParser.Model('CSSStyleRule').mix({
            id: [],
            selectors: utils.commaToArray(selectorText),
            family: utils.commaToArray(fontFamily).map(utils.unquotation),
            chars: content.split(''),
            options: {}
        });


        // 获取字体配置
        getFontId.keys.forEach(function (key, index) {
            var value = rule.style[key];

            if (typeof value !== 'string') {
                value = getFontId.values[index];
            }

            model.options[key] = value;
        });



        // 生成匹配的字体 ID 列表
        model.family.forEach(function (family) {
            var id = getFontId(family, model.options);
            model.id.push(id);
        });



        return model;
    },


    // 媒体查询规则
    CSSMediaRule: function (rule) {
        // CssParser.Parser
        return new this.constructor(rule, this.file, this.options);
    }

});






// 用来给字体指定唯一标识
// 字体的 ID 根据 font-family 以及其他 font-* 属性来生成
// @see https://github.com/aui/font-spider/issues/32
function getFontId (name, options) {

    var values = getFontId.keys.map(function (key, index) {

        var value = options[key];

        if (typeof value !== 'string') {
            value = getFontId.values[index];
        } else if (getFontId.alias[key]) {
            value = value.replace.apply(value, getFontId.alias[key]);
        }
        return value;
    });

    values.unshift(name);

    var id = values.join('-');
    id = getMd5(id);

    return id;
}


getFontId.keys = ['font-variant', 'font-stretch', 'font-weight', 'font-style'];
getFontId.values = ['normal', 'normal', 'normal', 'normal'];
getFontId.alias = {
    'font-weight': ['400', 'normal'],
};



function getMd5 (text) {
    return crypto.createHash('md5').update(text).digest('hex');
}


module.exports = CssParser;
