(function () {
    'use strict';

    // Защита от повторной инициализации
    if (window.plugin_lordfilm_ready) return;
    window.plugin_lordfilm_ready = true;

    var PLUGIN_NAME = 'Lordfilm.fi';
    var PLUGIN_VERSION = '1.0.0';
    var DEFAULT_DOMAIN = 'https://lordfilm.fi';
    var BALANCER_HOST = 'https://api.ortified.ws';

    // Хранилище настроек
    function getDomain() {
        var domain = Lampa.Storage.get('lordfilm_domain', DEFAULT_DOMAIN) + '';
        if (!domain) domain = DEFAULT_DOMAIN;
        if (domain.indexOf('://') === -1) domain = 'https://' + domain;
        if (domain.slice(-1) === '/') domain = domain.slice(0, -1);
        return domain;
    }

    function getProxyType() {
        return Lampa.Storage.get('lordfilm_proxy', 'auto');
    }

    function getCustomProxy() {
        var p = Lampa.Storage.get('lordfilm_custom_proxy', '') + '';
        if (p && p.slice(-1) !== '/') p += '/';
        return p;
    }

    // Применение прокси (если требуется для браузера / CORS)
    function applyProxy(url) {
        var type = getProxyType();
        if (type === 'none') return url;

        if (type === 'custom') {
            var custom = getCustomProxy();
            return custom ? custom + url : url;
        }

        if (type === 'worker1') {
            return 'https://cors.nb557.workers.dev/' + url;
        }

        if (type === 'worker2') {
            return 'https://cors.fx666.workers.dev/' + url;
        }

        // 'auto': если Lampa запущена в браузере (где есть строгий CORS), используем CORS-прокси.
        // На Android / ТВ с нативным клиентом запрос отправляется напрямую.
        if (type === 'auto') {
            if (Lampa.Platform.is('browser') || (location.protocol === 'http:' || location.protocol === 'https:')) {
                // Если запущен на lampa.mx или в обычном браузере
                if (location.hostname.indexOf('lampa') !== -1 || location.hostname.indexOf('localhost') !== -1) {
                    return 'https://cors.nb557.workers.dev/' + url;
                }
            }
        }

        return url;
    }

    function safeHash(str) {
        if (window.Lampa && Lampa.Utils && Lampa.Utils.hash) return Lampa.Utils.hash(str);
        var hash = 0;
        for (var i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash).toString(36);
    }

    function capitalize(str) {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    // Добавление стилей
    function addStyles() {
        var style = document.createElement('style');
        style.setAttribute('type', 'text/css');
        style.innerHTML = [
            '.view--lordfilm svg { width: 1.5em; height: 1.5em; margin-right: 0.6em; vertical-align: middle; }',
            '.lordfilm-item { position: relative; padding: 0.9em 1.2em; display: flex; align-items: center; justify-content: space-between; border-radius: 0.4em; }',
            '.lordfilm-item__body { flex: 1; min-width: 0; }',
            '.lordfilm-item__title { font-size: 1.15em; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
            '.lordfilm-item__details { font-size: 0.85em; color: rgba(255, 255, 255, 0.6); margin-top: 0.3em; display: flex; gap: 0.8em; align-items: center; }',
            '.lordfilm-item__badge { background: rgba(255, 255, 255, 0.15); padding: 0.15em 0.5em; border-radius: 0.25em; font-size: 0.8em; }',
            '.lordfilm-item__icons { display: flex; align-items: center; margin-left: 1em; gap: 0.5em; }',
            '.lordfilm-item__viewed { color: #4cd964; width: 1.3em; height: 1.3em; }',
            '.lordfilm-item__viewed svg { width: 100%; height: 100%; fill: currentColor; }',
            '.lordfilm-filter-info { padding: 0.6em 1.2em; font-size: 0.9em; color: rgba(255,255,255,0.5); }'
        ].join('\n');
        document.head.appendChild(style);
    }

    // Основной компонент поиска и просмотра Lordfilm
    function Component(object) {
        var network = new Lampa.Reguest();
        var scroll = new Lampa.Scroll({ mask: true, over: true });
        var files = new Lampa.Explorer(object);
        var filter = new Lampa.Filter(object);
        var empty = new Lampa.Empty();

        var current_movie = object.movie || {};
        var search_title = object.search || current_movie.title || current_movie.name || '';
        var search_year = parseInt(current_movie.release_date || current_movie.first_air_date || '') || null;

        var last_focus = null;
        var releases = []; // Результаты поиска на lordfilm.fi
        var selected_release = null;
        var playerData = null; // Распарсенные данные из makePlayer({...})

        var choice = {
            release: 0,
            season: 0,
            voice: 0
        };

        var filter_items = {
            release: [],
            season: [],
            voice: []
        };

        this.create = function () {
            var _this = this;

            filter.onSelect = function (type, a, b) {
                if (type === 'filter') {
                    choice[a.stype] = b.index;
                    _this.applyFilter();
                }
            };

            filter.render().find('.filter--sort').remove();
            files.appendHead(filter.render());
            files.appendFiles(scroll.render());

            this.startSearch();
            return this.render();
        };

        this.render = function () {
            return files.render();
        };

        this.startSearch = function () {
            var _this = this;
            this.activity.loader(true);
            scroll.clear();

            // Если у фильма уже есть kinopoisk_id, пробуем загрузить напрямую с балансера
            var kp_id = current_movie.kinopoisk_id || current_movie.kp_id;
            if (kp_id) {
                this.loadBalancer(kp_id, function (success) {
                    if (success) {
                        _this.activity.loader(false);
                    } else {
                        // Если прямой запрос по KP не дал результатов, ищем через сайт Lordfilm
                        _this.searchOnLordfilm();
                    }
                });
            } else {
                this.searchOnLordfilm();
            }
        };

        // Поиск по сайту lordfilm.fi
        this.searchOnLordfilm = function () {
            var _this = this;
            var domain = getDomain();
            var searchUrl = applyProxy(domain + '/index.php?do=search');
            var query = search_title.replace(/[^\w\s\u0400-\u04FF]/gi, ' ').trim();

            if (!query && current_movie.original_title) {
                query = current_movie.original_title.trim();
            }

            if (!query) {
                this.showEmpty('Не указано название для поиска');
                return;
            }

            var postData = 'do=search&subaction=search&story=' + encodeURIComponent(query);

            network.clear();
            network.timeout(12000);
            network.native(searchUrl, function (html) {
                _this.parseSearchResults(html);
            }, function (err) {
                // Если прямой запрос выдал ошибку, пробуем через резервный прокси
                var fallbackUrl = 'https://cors.nb557.workers.dev/' + domain + '/index.php?do=search';
                network.clear();
                network.timeout(12000);
                network.native(fallbackUrl, function (html) {
                    _this.parseSearchResults(html);
                }, function (err2) {
                    _this.showEmpty('Ошибка соединения с ' + domain + ' (' + (err2.message || 'сеть недоступна') + ')');
                }, postData, {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                });
            }, postData, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
        };

        // Разбор результатов поиска
        this.parseSearchResults = function (html) {
            var _this = this;
            releases = [];

            if (!html || html.indexOf('item expand-link') === -1) {
                this.showEmpty('Ничего не найдено на ' + PLUGIN_NAME);
                return;
            }

            var itemRegex = /<div class="item expand-link grid-items__item">([\s\S]*?)(?=<div class="item expand-link grid-items__item"|<\/div>\s*<!--\/noindex-->|<div class="bottom-nav"|$)/g;
            var match;

            while ((match = itemRegex.exec(html)) !== null) {
                var block = match[1];
                var linkM = block.match(/href="(https?:\/\/lordfilm\.fi\/[^"]+)"/) || block.match(/href="(\/[^"]+)"/);
                var titleM = block.match(/<a class="item__title[^"]*"[^>]*>([^<]+)<\/a>/);
                var yearM = block.match(/<div class="item__year">([^<]+)<\/div>/);

                if (linkM && titleM) {
                    var fullUrl = linkM[1];
                    if (fullUrl.indexOf('://') === -1) fullUrl = getDomain() + fullUrl;

                    var itemYear = yearM ? parseInt(yearM[1].trim()) : null;
                    releases.push({
                        title: capitalize(titleM[1].trim()),
                        url: fullUrl,
                        year: itemYear
                    });
                }
            }

            if (releases.length === 0) {
                this.showEmpty('Ничего не найдено по запросу: ' + search_title);
                return;
            }

            // Выбор наиболее подходящего релиза по году
            var bestIdx = 0;
            if (search_year) {
                for (var i = 0; i < releases.length; i++) {
                    if (releases[i].year && Math.abs(releases[i].year - search_year) <= 1) {
                        bestIdx = i;
                        break;
                    }
                }
            }

            choice.release = bestIdx;
            this.loadRelease(releases[bestIdx]);
        };

        // Загрузка страницы конкретного релиза на lordfilm.fi
        this.loadRelease = function (release) {
            var _this = this;
            this.activity.loader(true);
            selected_release = release;

            var pageUrl = applyProxy(release.url);

            network.clear();
            network.timeout(12000);
            network.native(pageUrl, function (html) {
                var kpId = null;
                // Ищем embed/kp/{id} или в посте uploads/posts/.../{id}_
                var kpMatch = html.match(/embed\/kp\/(\d+)/) || html.match(/\/uploads\/posts\/[^\/]+\/(\d+)_/);
                if (kpMatch) kpId = kpMatch[1];

                if (kpId) {
                    _this.loadBalancer(kpId, function (success) {
                        _this.activity.loader(false);
                        if (!success) {
                            _this.showEmpty('Плеер временно недоступен для этого релиза');
                        }
                    });
                } else {
                    _this.activity.loader(false);
                    _this.showEmpty('Не удалось извлечь плеер со страницы фильма');
                }
            }, function (err) {
                _this.activity.loader(false);
                _this.showEmpty('Не удалось открыть страницу фильма на ' + PLUGIN_NAME);
            });
        };

        // Загрузка данных из плеера api.ortified.ws/embed/kp/{id}
        this.loadBalancer = function (kpId, callback) {
            var _this = this;
            var balancerUrl = BALANCER_HOST + '/embed/kp/' + kpId + '?host=lordfilm.fi';

            network.clear();
            network.timeout(12000);
            network.native(balancerUrl, function (html) {
                var find = (html || '').replace(/\n/g, '').match(/makePlayer\(({.*?})\);/);
                var data = null;

                if (find && find[1]) {
                    try {
                        data = (0, eval)('"use strict"; (' + find[1] + ');');
                    } catch (e) {
                        console.error('Lordfilm makePlayer parse error', e);
                    }
                }

                if (data && (data.source || (data.playlist && data.playlist.seasons))) {
                    playerData = data;
                    _this.buildFilters();
                    _this.renderList();
                    if (callback) callback(true);
                } else {
                    if (callback) callback(false);
                }
            }, function (err) {
                if (callback) callback(false);
            });
        };

        // Построение фильтров
        this.buildFilters = function () {
            filter_items.release = releases.map(function (rel) {
                return (rel.year ? '[' + rel.year + '] ' : '') + rel.title;
            });

            filter_items.season = [];
            filter_items.voice = [];

            if (playerData.playlist && playerData.playlist.seasons) {
                // Сортировка сезонов по возрастанию
                playerData.playlist.seasons.sort(function (a, b) {
                    return a.season - b.season;
                });

                playerData.playlist.seasons.forEach(function (s) {
                    filter_items.season.push(Lampa.Lang.translate('torrent_serial_season') + ' ' + s.season);
                });

                if (choice.season >= filter_items.season.length) choice.season = 0;

                // Озвучки текущего сезона/эпизода
                var curSeason = playerData.playlist.seasons[choice.season];
                if (curSeason && curSeason.episodes && curSeason.episodes[0] && curSeason.episodes[0].audio) {
                    filter_items.voice = curSeason.episodes[0].audio.names || [];
                }
            } else if (playerData.source && playerData.source.audio) {
                filter_items.voice = playerData.source.audio.names || [];
            }

            if (choice.voice >= filter_items.voice.length) choice.voice = 0;

            var toFilter = {};
            if (filter_items.release.length > 1) toFilter.release = filter_items.release;
            if (filter_items.season.length > 0) toFilter.season = filter_items.season;
            if (filter_items.voice.length > 1) toFilter.voice = filter_items.voice;

            filter.set('filter', toFilter);
            filter.chosen('filter', choice);
        };

        // Применение изменений в фильтре
        this.applyFilter = function () {
            if (filter_items.release.length > 1 && releases[choice.release] && releases[choice.release] !== selected_release) {
                this.loadRelease(releases[choice.release]);
                return;
            }

            // Обновляем список озвучек для выбранного сезона
            if (playerData && playerData.playlist && playerData.playlist.seasons) {
                var curSeason = playerData.playlist.seasons[choice.season];
                if (curSeason && curSeason.episodes && curSeason.episodes[0] && curSeason.episodes[0].audio) {
                    filter_items.voice = curSeason.episodes[0].audio.names || [];
                    if (choice.voice >= filter_items.voice.length) choice.voice = 0;
                    filter.set('filter', {
                        season: filter_items.season,
                        voice: filter_items.voice
                    });
                    filter.chosen('filter', choice);
                }
            }

            this.renderList();
        };

        // Вспомогательное контекстное меню для элемента
        this.bindContextMenu = function (item, fileHash) {
            item.on('hover:long', function () {
                var enabled = Lampa.Controller.enabled().name;
                var viewed_files = Lampa.Storage.cache('online_viewed', 500, []);
                var isViewed = viewed_files.indexOf(fileHash) !== -1;

                var menu = [
                    {
                        title: isViewed ? 'Снять отметку о просмотре' : 'Отметить как просмотренное',
                        toggle_viewed: true
                    },
                    {
                        title: 'Сбросить время просмотра',
                        reset_timeline: true
                    }
                ];

                Lampa.Select.show({
                    title: 'Действие',
                    items: menu,
                    onBack: function () {
                        Lampa.Controller.toggle(enabled);
                    },
                    onSelect: function (a) {
                        if (a.toggle_viewed) {
                            var vf = Lampa.Storage.cache('online_viewed', 500, []);
                            var pos = vf.indexOf(fileHash);
                            if (pos !== -1) {
                                vf.splice(pos, 1);
                                item.find('.lordfilm-item__viewed').remove();
                            } else {
                                vf.push(fileHash);
                                if (item.find('.lordfilm-item__viewed').length === 0) {
                                    item.find('.lordfilm-item__icons').append('<div class="lordfilm-item__viewed"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>');
                                }
                            }
                            Lampa.Storage.set('online_viewed', vf);
                        }
                        if (a.reset_timeline) {
                            var tl = Lampa.Storage.get('file_view', '{}');
                            delete tl[fileHash];
                            Lampa.Storage.set('file_view', tl);
                            Lampa.Noty.show('Время сброшено');
                        }
                        Lampa.Controller.toggle(enabled);
                    }
                });
            });
        };

        // Отрисовка списка файлов / серий
        this.renderList = function () {
            var _this = this;
            scroll.clear();

            if (!playerData) {
                this.showEmpty('Данные видео отсутствуют');
                return;
            }

            var viewed_files = Lampa.Storage.cache('online_viewed', 500, []);

            // 1. СЕРИАЛ
            if (playerData.playlist && playerData.playlist.seasons) {
                var seasonObj = playerData.playlist.seasons[choice.season];
                if (!seasonObj || !seasonObj.episodes || seasonObj.episodes.length === 0) {
                    this.showEmpty('Серии в этом сезоне не найдены');
                    return;
                }

                var playlist = [];

                seasonObj.episodes.forEach(function (ep, idx) {
                    var epTitle = Lampa.Lang.translate('torrent_serial_episode') + ' ' + ep.episode + (ep.title ? ' — ' + ep.title : '');
                    var fileHash = safeHash(search_title + '_s' + seasonObj.season + 'e' + ep.episode);
                    var isViewed = viewed_files.indexOf(fileHash) !== -1;

                    var item = $([
                        '<div class="lordfilm-item selector">',
                            '<div class="lordfilm-item__body">',
                                '<div class="lordfilm-item__title">' + epTitle + '</div>',
                                '<div class="lordfilm-item__details">',
                                    '<span class="lordfilm-item__badge">' + (seasonObj.season + 'x' + ep.episode) + '</span>',
                                    '<span>' + (filter_items.voice[choice.voice] || 'Основная озвучка') + '</span>',
                                    (ep.duration ? '<span>' + Math.round(ep.duration / 60) + ' мин.</span>' : ''),
                                '</div>',
                            '</div>',
                            '<div class="lordfilm-item__icons">',
                                (isViewed ? '<div class="lordfilm-item__viewed"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>' : ''),
                            '</div>',
                        '</div>'
                    ].join(''));

                    // Подготовка элемента плейлиста для Lampa.Player
                    var streamUrl = ep.hls || ep.dash || '';
                    var subtitles = (ep.cc || []).map(function (sub) {
                        return {
                            label: sub.name,
                            url: sub.url
                        };
                    });

                    var playCell = {
                        title: search_title + ' (' + seasonObj.season + 'x' + ep.episode + ')',
                        url: streamUrl,
                        subtitles: subtitles,
                        timeline: {
                            hash: fileHash
                        }
                    };
                    playlist.push(playCell);

                    item.on('hover:enter', function () {
                        _this.playItem(playCell, playlist, idx, fileHash, item);
                    });

                    _this.bindContextMenu(item, fileHash);

                    item.on('hover:focus', function (e) {
                        last_focus = e.target;
                        scroll.update($(e.target), true);
                    });

                    scroll.append(item);
                });
            }
            // 2. ОДИНОЧНЫЙ ФИЛЬМ
            else if (playerData.source) {
                var streamUrl = playerData.source.hls || playerData.source.dash || '';
                var currentVoice = filter_items.voice[choice.voice] || 'Стандартная дорожка';
                var fileHash = safeHash(search_title + '_movie');
                var isViewed = viewed_files.indexOf(fileHash) !== -1;

                var subtitles = (playerData.source.cc || []).map(function (sub) {
                    return {
                        label: sub.name,
                        url: sub.url
                    };
                });

                var item = $([
                    '<div class="lordfilm-item selector">',
                        '<div class="lordfilm-item__body">',
                            '<div class="lordfilm-item__title">' + (playerData.title || search_title) + '</div>',
                            '<div class="lordfilm-item__details">',
                                '<span class="lordfilm-item__badge">Фильм</span>',
                                '<span>' + currentVoice + '</span>',
                                '<span class="lordfilm-item__badge">HLS 1080p</span>',
                            '</div>',
                        '</div>',
                        '<div class="lordfilm-item__icons">',
                            (isViewed ? '<div class="lordfilm-item__viewed"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>' : ''),
                        '</div>',
                    '</div>'
                ].join(''));

                var playCell = {
                    title: (playerData.title || search_title) + ' [' + currentVoice + ']',
                    url: streamUrl,
                    subtitles: subtitles,
                    timeline: {
                        hash: fileHash
                    }
                };

                item.on('hover:enter', function () {
                    _this.playItem(playCell, [playCell], 0, fileHash, item);
                });

                _this.bindContextMenu(item, fileHash);

                item.on('hover:focus', function (e) {
                    last_focus = e.target;
                    scroll.update($(e.target), true);
                });

                scroll.append(item);
            }

            Lampa.Controller.enable('content');
        };

        // Запуск воспроизведения
        this.playItem = function (firstItem, playlist, startIndex, fileHash, elementDom) {
            if (!firstItem.url) {
                Lampa.Noty.show('Ссылка на видео не найдена');
                return;
            }

            // Добавляем в историю просмотров Lampa
            if (current_movie.id) {
                Lampa.Favorite.add('history', current_movie, 100);
            }

            // Отмечаем как просмотренное
            var viewed_files = Lampa.Storage.cache('online_viewed', 500, []);
            if (viewed_files.indexOf(fileHash) === -1) {
                viewed_files.push(fileHash);
                Lampa.Storage.set('online_viewed', viewed_files);
                if (elementDom && elementDom.find('.lordfilm-item__viewed').length === 0) {
                    elementDom.find('.lordfilm-item__icons').append('<div class="lordfilm-item__viewed"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>');
                }
            }

            // Воспроизведение через плеер Lampa
            Lampa.Player.play(firstItem);

            if (playlist && playlist.length > 1) {
                var orderedPlaylist = playlist.slice(startIndex).concat(playlist.slice(0, startIndex));
                Lampa.Player.playlist(orderedPlaylist);
            } else {
                Lampa.Player.playlist([firstItem]);
            }
        };

        this.showEmpty = function (msg) {
            empty.render().find('.empty__descr').text(msg || 'Ничего не найдено');
            scroll.clear();
            scroll.append(empty.render());
            Lampa.Controller.enable('content');
        };

        this.start = function () {
            Lampa.Controller.add('content', {
                toggle: function () {
                    Lampa.Controller.collectionSet(scroll.render());
                    Lampa.Controller.collectionFocus(last_focus || false, scroll.render());
                },
                left: function () {
                    if (Navigator.canmove('left')) Navigator.move('left');
                    else Lampa.Controller.toggle('menu');
                },
                right: function () {
                    Navigator.move('right');
                },
                up: function () {
                    if (Navigator.canmove('up')) Navigator.move('up');
                    else Lampa.Controller.toggle('head');
                },
                down: function () {
                    Navigator.move('down');
                },
                back: function () {
                    Lampa.Activity.backward();
                }
            });

            Lampa.Controller.toggle('content');
        };

        this.pause = function () {};
        this.stop = function () {};
        this.destroy = function () {
            network.clear();
            scroll.destroy();
            files.destroy();
            filter.destroy();
            empty.destroy();
        };
    }

    // Инициализация кнопки в карточке фильма/сериала
    function initCardButton() {
        var buttonTemplate = [
            '<div class="full-start__button selector view--lordfilm" data-subtitle="Lordfilm.fi">',
                '<svg viewBox="0 0 24 24" fill="currentColor">',
                    '<path d="M18 3v2h-2V3H8v2H6V3H4v18h2v-2h2v2h8v-2h2v2h2V3h-2zM8 17H6v-2h2v2zm0-4H6v-2h2v2zm0-4H6V7h2v2zm10 8h-2v-2h2v2zm0-4h-2v-2h2v2zm0-4h-2V7h2v2z"/>',
                '</svg>',
                '<span>Lordfilm</span>',
            '</div>'
        ].join('');

        Lampa.Listener.follow('full', function (e) {
            if (e.type === 'complite') {
                var btn = $(buttonTemplate);

                btn.on('hover:enter', function () {
                    Lampa.Component.add('lordfilm', Component);
                    Lampa.Activity.push({
                        url: '',
                        title: 'Lordfilm — ' + (e.data.movie.title || e.data.movie.name),
                        component: 'lordfilm',
                        movie: e.data.movie,
                        search: e.data.movie.title || e.data.movie.name,
                        page: 1
                    });
                });

                var target = e.object.activity.render().find('.view--torrent');
                if (target.length) {
                    target.after(btn);
                } else {
                    e.object.activity.render().find('.full-start__buttons').append(btn);
                }
            }
        });
    }

    // Добавление параметров в настройки Lampa
    function initSettings() {
        if (Lampa.SettingsApi) {
            Lampa.SettingsApi.addComponent({
                component: 'lordfilm',
                name: 'Lordfilm.fi',
                icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 3v2h-2V3H8v2H6V3H4v18h2v-2h2v2h8v-2h2v2h2V3h-2z"/></svg>'
            });

            Lampa.SettingsApi.addParam({
                component: 'lordfilm',
                param: {
                    name: 'lordfilm_domain',
                    type: 'input',
                    default: DEFAULT_DOMAIN,
                    values: DEFAULT_DOMAIN
                },
                field: {
                    name: 'Адрес сайта',
                    description: 'Основной домен или зеркало Lordfilm (по умолчанию https://lordfilm.fi)'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'lordfilm',
                param: {
                    name: 'lordfilm_proxy',
                    type: 'select',
                    values: {
                        'auto': 'Автоматически (CORS для web)',
                        'none': 'Напрямую (без прокси)',
                        'worker1': 'CORS Worker 1',
                        'worker2': 'CORS Worker 2',
                        'custom': 'Пользовательский'
                    },
                    default: 'auto'
                },
                field: {
                    name: 'Проксирование запросов',
                    description: 'Использовать прокси для браузера или обхода блокировок'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'lordfilm',
                param: {
                    name: 'lordfilm_custom_proxy',
                    type: 'input',
                    default: '',
                    values: ''
                },
                field: {
                    name: 'Пользовательский прокси',
                    description: 'URL вашего CORS-прокси (например: https://my-cors.workers.dev/)'
                }
            });
        }
    }

    // Регистрация в плагинах Lampa
    function initPlugin() {
        Lampa.Component.add('lordfilm', Component);

        var manifest = {
            type: 'video',
            version: PLUGIN_VERSION,
            name: PLUGIN_NAME,
            description: 'Просмотр фильмов и сериалов онлайн с Lordfilm.fi',
            component: 'lordfilm',
            onContextMenu: function (object) {
                return {
                    name: 'Lordfilm',
                    description: 'Смотреть онлайн на Lordfilm'
                };
            },
            onContextLauch: function (object) {
                Lampa.Component.add('lordfilm', Component);
                Lampa.Activity.push({
                    url: '',
                    title: 'Lordfilm — ' + (object.title || object.name),
                    component: 'lordfilm',
                    movie: object,
                    search: object.title || object.name,
                    page: 1
                });
            }
        };

        if (Lampa.Manifest && Lampa.Manifest.plugins) {
            if (Array.isArray(Lampa.Manifest.plugins)) {
                Lampa.Manifest.plugins.push(manifest);
            }
        }

        addStyles();
        initCardButton();
        initSettings();
    }

    // Точка входа
    if (window.Lampa && Lampa.Listener) {
        initPlugin();
    } else {
        var checkReady = setInterval(function () {
            if (window.Lampa && Lampa.Listener) {
                clearInterval(checkReady);
                initPlugin();
            }
        }, 100);
    }
})();
