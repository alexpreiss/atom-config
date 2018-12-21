'use strict';

// Contents of this plugin will be reset by Kite on start.
// Changes you make are not guaranteed to persist.

let child_process, CompositeDisposable, TextEditor, AccountManager,
  Logger, completions, metrics, KiteApp,
  KiteStatus, KiteStatusPanel, NotificationsCenter,
  RollbarReporter, OverlayManager, KiteEditors, DataLoader,
  DisposableEvent, Disposable, EditorEvents, KiteAPI, VirtualCursor, NodeClient, KiteConnect;

const Kite = module.exports = {

  getModule(name) {
    return this.modules && this.modules[name];
  },

  registerModule(name, mod) {
    if (!name) {
      throw new Error('module name is mandatory');
    }
    if (this.modules && name in this.modules) {
      throw new Error(`a module with name '${name}' has already been registered`);
    }
    if (typeof mod != 'object' || !mod.init || !mod.dispose) {
      throw new Error('module must be an object with init and dispose method');
    }

    this.modules = this.modules || {};
    this.modules[name] = mod;

    this.requestModuleInit(mod);
  },

  disposeModules() {
    this.modules && Object.values(this.modules).forEach(mod => mod.dispose());
    delete this.modules;
  },

  requestModuleInit(mod) {
    this.modulesToActivate = this.modulesToActivate || [];

    this.modulesToActivate.push(mod);

    if (this.activationRequested) { return; }

    this.activationRequested = true;
    requestAnimationFrame(() => {
      this.modulesToActivate.forEach(mod => mod.init());
      delete this.modulesToActivate;
      delete this.activationRequested;
    });
  },

  activate() {
    // Lazy load all the things, at least all the things we need during activation
    // In terms of performance it means that all these requires won't be measured
    // in the package loading time but in the activation time.
    if (!AccountManager) {
      require('./elements/kite-links');

      ({CompositeDisposable, TextEditor, Disposable} = require('atom'));
      ({AccountManager, Logger} = require('kite-installer'));

      KiteApp = require('./kite-app');
      KiteAPI = require('kite-api');
      KiteConnect = require('kite-connector');
      NodeClient = require('kite-connector/lib/clients/node');
      NotificationsCenter = require('./notifications-center');
      RollbarReporter = require('./rollbar-reporter');
      metrics = require('./metrics.js');
      DataLoader = require('./data-loader');
      KiteEditors = require('./editors');
    }

    metrics.featureRequested('starting');

    // April 2018
    if (atom.config.get('kite.showDocsNotificationOnStartup') != undefined) {
      atom.config.set('kite.showWelcomeNotificationOnStartup',
          atom.config.get('kite.showDocsNotificationOnStartup'));
      atom.config.unset('kite.showDocsNotificationOnStartup');
    }

    // We store all the subscriptions into a composite disposable to release
    // them on deactivation
    this.subscriptions = new CompositeDisposable();

    if (!atom.inSpecMode()) {
      this.subscriptions.add(atom.config.observe('kite.developerMode', value => {
        if (value && KiteConnect.client instanceof NodeClient) {
          KiteConnect.toggleRequestDebug();
        } else if (!value && !(KiteConnect.client instanceof NodeClient)) {
          KiteConnect.toggleRequestDebug();
        }
      }));
    }

    this.registerModule('editors', new KiteEditors());

    this.subscriptions.add(KiteAPI.onDidDetectWhitelistedPath(path => {
      const status = this.getStatusItem();
      this.getEditorsForPath(path).forEach(e => {
        status.setState(KiteApp.STATES.WHITELISTED, true, e);
      });
    }));

    this.subscriptions.add(KiteAPI.onDidDetectNonWhitelistedPath(path => {
      const status = this.getStatusItem();

      this.getEditorsForPath(path).forEach(e => {
        status.setState(KiteApp.STATES.AUTHENTICATED, true, e);
        DataLoader.shouldOfferWhitelist(e)
        .then(res => {
          if (res) {
            this.notifications.warnNotWhitelisted(e, res);
          }
        })
        .catch(err => console.error(err));
      });
    }));

    this.subscriptions.add(KiteAPI.onDidFailRequest(err => {
      const e = atom.workspace.getActiveTextEditor();
      const supported = e && this.getModule('editors').isGrammarSupported(e);
      this.getStatusItem().setState(err.data.state, supported, e);
    }));

    // run "apm upgrade kite"
    this.selfUpdate();

    this.app = new KiteApp(this);
    this.notifications = new NotificationsCenter(this.app);
    this.reporter = new RollbarReporter();

    // All these objects have a dispose method so we can just
    // add them to the subscription.
    this.subscriptions.add(this.app);
    this.subscriptions.add(this.notifications);
    this.subscriptions.add(this.reporter);

    this.getStatusItem().setApp(this.app);
    this.getStatusPanel().setApp(this.app);

    this.subscriptions.add(this.getStatusItem().onDidClick(status => {
      metrics.featureRequested('status_panel');
      this.getStatusPanel().show(this.getStatusItem()).then(() => {
        metrics.featureFulfilled('status_panel');
      });
    }));

    this.subscriptions.add(atom.workspace.onDidChangeActivePaneItem(item => {
      const statusItem = this.getStatusItem();
      if (item instanceof TextEditor) {
        statusItem.preventUpdatesOnGetState();
        this.checkTextEditor(item).then(([state, supported]) => {
          statusItem.setState(state, supported, item);
          statusItem.resumeUpdatesOnGetState();
        });
      } else {
        this.app.connect().then(state => {
          statusItem.setState(state, false, null);
        });
      }
    }));

    // if supported files were open before Kite gets ready we
    // need to subscribe to these editors as well
    this.subscriptions.add(this.app.onKiteReady(() => {
      atom.workspace.getTextEditors()
      .filter(e => this.getModule('editors').isGrammarSupported(e))
      .forEach(e => {
        if (!DisposableEvent) { ({DisposableEvent} = require('./utils')); }

        const v = atom.views.getView(e);
        const sub = new DisposableEvent(v, 'focus', (evt) => {
          this.checkTextEditor(e);
          sub.dispose();
        });
      });
    }));

    // We listen to any opened URI to catch when the user open the settings
    // panel and pick the kite settings
    this.subscriptions.add(atom.workspace.onDidOpen(e => {
      if (e.uri === 'atom://config' && !this.settingsViewSubscription) {
        if (!DisposableEvent) { ({DisposableEvent} = require('./utils')); }

        const settingsView = e.item;

        this.settingsViewSubscription = new DisposableEvent(settingsView.element, 'mouseup', () => {
          setTimeout(() => {
            const kiteSettings = settingsView.panelsByName['kite'];
            if (kiteSettings && kiteSettings.element.style.display !== 'none') {
              metrics.featureRequested('settings');
              metrics.featureFulfilled('settings');
            }
          }, 100);
        });

        this.subscriptions.add(this.settingsViewSubscription);
      }
    }));

    // Whenever an action is accomplished through the kite app
    // we need to check again the state of the app
    this.subscriptions.add(this.app.onDidInstall(() => this.connect('onDidInstall')));
    this.subscriptions.add(this.app.onDidStart(() => this.connect('onDidStart')));
    this.subscriptions.add(this.app.onDidAuthenticate(() => this.connect('onDidAuthenticate')));
    this.subscriptions.add(this.app.onDidWhitelist(() => this.connect('onDidWhitelist')));

    // CONFIG

    // little thing to take out legacy config name value so it won't show up on settings
    atom.config.unset('kite.actionWhenKiteFixesCode');
    /*
    this.subscriptions.add(atom.config.onDidChange('kite.actionWhenErrorRescueFixesCode', ({oldValue}) => {
      if (oldValue === ERROR_RESCUE_SHOW_SIDEBAR) {
        metrics.sendFeatureMetric('atom_autocorrect_show_panel_disabled');
      } else {
        metrics.sendFeatureMetric('atom_autocorrect_show_panel_enabled');
      }
    }));*/

    this.subscriptions.add(atom.config.observe('kite.loggingLevel', (level) => {
      Logger.LEVEL = Logger.LEVELS[level.toUpperCase()];
    }));

    this.subscriptions.add(atom.config.observe('core.useTreeSitterParsers', (using) => {
      if (using) {
        const notif = atom.notifications.addWarning('Kite is not configured properly', {
          description: 'You must turn off Atom\'s tree-sitter parser for Kite to show you information on how to call functions. <a href="https://help.kite.com/article/80-why-do-i-need-to-turn-off-tree-sitter">Learn more</a>\n\nRestart will occur after a few seconds.',
          dismissable: true,
          buttons: [{
            text: 'Turn off and restart',
            onDidClick() {
              atom.config.set('core.useTreeSitterParsers', false);
              notif.dismiss();
              setTimeout(() => {
                atom.reload();
              }, 1500);
            },
          }],
        });
      }
    }));

    // COMMANDS

    this.subscriptions.add(atom.commands.add('atom-text-editor[data-grammar="source python"]', {
      // Allow esc key to close expand view
      'core:cancel': () => {
        if (!OverlayManager) { OverlayManager = require('./overlay-manager'); }
        OverlayManager.dismiss();
      },
      'kite:docs-at-cursor': () => { this.expandAtCursor(); },
    }));

    // This listens to the save-all command and add a temporary flag
    // so that we can detect when a save hook is triggered by save-all
    // versus save
    this.subscriptions.add(atom.commands.onDidDispatch((e) => {
      if (e.type === 'window:save-all') {
        metrics.sendFeatureMetric('atom_save_all_triggered');
        this.saveAllTriggered = true;
        setTimeout(() => {
          delete this.saveAllTriggered;
        }, 50);
      }
    }));

    this.subscriptions.add(atom.commands.add('atom-overlay kite-expand', {
      'core:cancel'() { this.remove(); },
    }));

    this.subscriptions.add(atom.commands.add('atom-workspace', {
      'kite:permissions': () => this.openPermissions(),
      'kite:tutorial': () => this.openKiteTutorial(true),
      'kite:general-settings': () => this.openSettings(),
      'kite:open-copilot': () => this.openCopilot(),
      'kite:editor-plugin-settings': () =>
        atom.applicationDelegate.openExternal('atom://settings-view/show-package?package=kite'),
      'kite:help-docs': () =>
        atom.applicationDelegate.openExternal('https://help.kite.com/category/43-atom-integration'),
      'kite:status': () => {
        metrics.featureRequested('status_panel');
        this.getStatusPanel().show(this.getStatusItem()).then(() => {
          metrics.featureFulfilled('status_panel');
        });
      },
    }));

    // START

    this.patchCompletions();

    this.pollingInterval = setInterval(() => {
      this.connect('pollingInterval');
    }, atom.config.get('kite.pollingInterval'));

    // onboarding handling
    //open kite onboarding if flag indicates so
    if (atom.config.get('kite.showWelcomeNotificationOnStartup')) {
      this.openKiteTutorial();
    }

    this.notifications.startupNotifications();
    // setTimeout(() => this.startupNotifications(), 500);

    // Store the last expand at cursor highlight. This is necessary
    // for navigable panel to turn it red when no data comes back.
    this.lastExpandAtCursorHighlight = null;

    // We try to connect at startup
    this.app.connect('activation').then(state => {
      if (state === KiteApp.STATES.UNINSTALLED && !this.app.wasInstalledOnce()) {
        this.app.installFlow();
      } else if (state !== KiteApp.STATES.UNINSTALLED) {
        this.app.saveUserID();

        if (state === KiteApp.STATES.NOT_RUNNING && atom.config.get('kite.startKiteAtStartup')) {
          this.app.start().then(() => this.app.connect('activation'));
        }
      }

      if (atom.workspace.getActiveTextEditor()) {
        this.checkTextEditor(atom.workspace.getActiveTextEditor());
      }
    });

    metrics.featureFulfilled('starting');
  },

  connect(src) {
    return this.app.connect(src);
  },

  registerEditorEvents(editor) {
    if (!EditorEvents) { EditorEvents = require('./editor-events'); }

    if (!this.eventsByEditorID[editor.id]) {
      const evt = this.eventsByEditorID[editor.id] = new EditorEvents(editor);
      if (editor === atom.workspace.getActiveTextEditor()) {
        evt.focus();
      }
    }
  },

  getEditorsForPath(path) {
    return atom.workspace.getPaneItems().filter(i => i && i.getURI && i.getURI() === path);
  },

  checkTextEditor(editor, src) {
    //src and from act to pass into connect the named of the context in which
    //the function was called, so that connect can handle error state appropriately
    const check = (editor, from) => this.app.connect(from).then(state => {
      const supported = this.getModule('editors').isGrammarSupported(editor);
      // we only subscribe to the editor if it's a
      // python file and we're authenticated
      if (supported) {
        if (state >= KiteApp.STATES.AUTHENTICATED) {
          return Promise.resolve([
            this.getModule('editors').isEditorWhitelisted(editor)
              ? KiteApp.STATES.WHITELISTED
              : state,
            supported,
          ])
          .catch(err => {
            return [state, supported];
          });
        } else {
          return Promise.resolve([state, supported]);
        }
      } else {
        return Promise.resolve([state, supported]);
      }
    });

    return editor.getPath()
      ? check(editor, src)
      : Promise.reject();
  },

  deactivate() {
    this.disposeModules();

    clearInterval(this.pollingInterval);
    clearInterval(this.healthInterval);
    // Release all subscriptions on deactivation
    metrics.featureRequested('stopping');
    this.subscriptions.dispose();
    metrics.featureFulfilled('stopping');
  },

  selfUpdate() {
    if (!child_process) { child_process = require('child_process'); }
    const apm = atom.packages.getApmPath();

    child_process.spawn(apm, ['update', 'kite']);
  },

  consumeStatusBar(statusbar) {
    statusbar.addRightTile({item: this.getStatusItem()});
  },

  activateAndShowItem(item) {
    if (item) {
      const dock = atom.workspace.paneContainerForURI(item.getURI());
      const pane = atom.workspace.paneForURI(item.getURI());

      if (pane && dock) {
        dock.show();
        pane.setActiveItem(item);
      }
    }
  },

  expandAtCursor(editor) {
    editor = editor || atom.workspace.getActiveTextEditor();

    if (!editor) { return; }

    const position = editor.getLastCursor().getBufferPosition();

    this.highlightWordAtPosition(editor, position);

    if (!editor.getPath()) { return; }

    DataLoader.getHoverDataAtPosition(editor, position).then(data => {
      const [symbol] = data.symbol;

      if (symbol && symbol.id) {
        atom.applicationDelegate.openExternal(`kite://docs/${symbol.id}`);
      }
    });
  },

  highlightWordAtPosition(editor, position, cls = '') {
    if (!VirtualCursor) { VirtualCursor = require('./virtual-cursor'); }

    const cursor = new VirtualCursor(editor, position);
    const range = cursor.getCurrentWordBufferRange({
      includeNonWordCharacters: false,
    });
    const marker = editor.markBufferRange(range, {
      invalidate: 'touch',
    });
    const decoration = editor.decorateMarker(marker, {
      type: 'highlight',
      class: `expand-at-cursor-highlight ${cls}`,
      item: this,
    });

    // Timed for all transition to be finished by then
    setTimeout(() => decoration.destroy(), 800);
  },

  getStatusItem() {
    if (this.status) { return this.status; }
    if (!KiteStatus) { KiteStatus = require('./elements/kite-status'); }

    this.status = new KiteStatus();
    this.status.Kite = this;
    return this.status;
  },

  getStatusPanel() {
    if (this.statusPanel) { return this.statusPanel; }
    if (!KiteStatusPanel) { KiteStatusPanel = require('./elements/kite-status-panel'); }

    this.statusPanel = new KiteStatusPanel();
    return this.statusPanel;
  },

  completions() {
    if (!completions) { completions = require('./completions'); }
    return completions;
  },

  openPermissions() {
    const url = 'kite://settings/permissions';
    atom.applicationDelegate.openExternal(url);
  },

  openSettings() {
    const url = 'kite://settings';
    atom.applicationDelegate.openExternal(url);
  },

  openKiteTutorial(fromCommand) {
    if (fromCommand) {
      KiteAPI.getOnboardingFilePath().then(path => {
        atom.workspace.open(path);
      })
      .catch((err) => {
        this.notifications.warnOnboardingFileFailure();
      });
    } else {
      KiteAPI.isKiteLocal().then(isLocal => {
        if (isLocal) {
          // then attempt live onboarding
          KiteAPI.getKiteSetting('has_done_onboarding')
          .then(hasDone => {
            if (!hasDone) {
              KiteAPI.getOnboardingFilePath().then(path => {
                atom.workspace.open(path);
                this.notifications.onboardingNotifications();
                KiteAPI.setKiteSetting('has_done_onboarding', true);
              })
              .catch((err) => {
                this.notifications.warnOnboardingFileFailure();
              });
            } else {
              // do welcome notification without onboarding reference
              this.notifications.onboardingNotifications(true);
            }
          });
        } else {
          // do welcome notification without onboarding reference
          this.notifications.onboardingNotifications(true);
        }
      });
    }
  },

  openCopilot() {
    const url = 'kite://home';
    atom.applicationDelegate.openExternal(url);
  },

  errorRescueVersion() {
    const version = localStorage.getItem('kite.autocorrect_model_version');
    return version ? parseInt(version, 10) : version;
  },

  isSaveAll() {
    return this.saveAllTriggered;
  },

  patchCompletions() {
    atom.packages.activatePackage('autocomplete-python')
    .then(acp => {
      const safeProvider = acp.mainModule.provider.getSuggestions;
      acp.mainModule.provider.getSuggestions = (options) => {
        const {prefix} = options;
        const res = safeProvider.call(acp.mainModule.provider, options);

        return res && res.then
          ? res.then(res => /\($/.test(prefix) ? [] : res)
          : /\($/.test(prefix) ? [] : res;
      };
    }).catch(() => {});

    atom.packages.activatePackage('autocomplete-plus')
    .then(autocompletePlus => {
      const acp = autocompletePlus.mainModule;
      const manager = acp.autocompleteManager || acp.getAutocompleteManager();
      const list = manager.suggestionList;
      const listElement = list.suggestionListElement
        ? list.suggestionListElement
        : atom.views.getView(list);

      const safeUpdate = listElement && listElement.updateDescription;
      const safeDisplay = manager && manager.displaySuggestions;
      const safeShowOrHide = manager && manager.showOrHideSuggestionListForBufferChanges;
      const safeConfirm = manager && manager.confirm;
      const safeCursorMoved = manager && manager.cursorMoved;
      const safeHide = manager && manager.hideSuggestionList;

      if (safeDisplay) {
        const element = listElement.element
          ? listElement.element
          : listElement;

        let confirmed;

        this.subscriptions.add(new Disposable(() => {
          listElement.updateDescription = safeUpdate;
          manager.displaySuggestions = safeDisplay;
          manager.showOrHideSuggestionListForBufferChanges = safeShowOrHide;
          manager.confirm = safeConfirm;
          manager.cursorMoved = safeCursorMoved;
          manager.hideSuggestionList = safeHide;
        }));

        manager.confirm = (suggestion) => {
          confirmed = true;
          requestAnimationFrame(() => confirmed = false);
          return safeConfirm.call(manager, suggestion);
        };

        manager.hideSuggestionList = () => {
          const editor = atom.workspace.getActiveTextEditor();
          if (typeof editor !== 'undefined') {
            const position = editor.getCursorBufferPosition();
            if (completions.isSignaturePanelVisible()
                && (completions.isInsideFunctionCall(editor, position)
                || completions.isOnFunctionCallBrackets(editor, position))) {
              manager.suggestionList.changeItems(null);
              element.querySelector('.suggestion-description').style.display = 'none';
            } else {
              safeHide.call(manager);
            }
          }
        };

        manager.cursorMoved = (event) => {
          const editor = event.cursor.editor;
          const position = event.newBufferPosition;

          if (completions
              && (
                completions.isInsideFunctionCall(editor, position)
                || completions.isOnFunctionCallBrackets(editor, position)
              )
              && completions.isSignaturePanelVisible()) {

            manager.suggestionList.changeItems(null);
            element.querySelector('.suggestion-description').style.display = 'none';
            completions.loadSignature({editor, position}).then(shown => {
              if (!shown) {
                safeHide.call();
              }
            });
            // refresh sig
          } else {
            safeCursorMoved.call(manager, event);
          }
        };

        manager.showOrHideSuggestionListForBufferChanges = (options) => {
          if (confirmed) {
            // autocomplete-plus operates on the last change, so do we
            const change = options.changes[options.changes.length - 1];

            // we know we have confirmed a suggestion for a 1 char entry with a
            // 1 char trigger, we cancel the new suggestion request and hide
            // the suggestions using the same routine than autocomplete-plus
            if (change.oldText.length === 1 && change.newText.length === 1) {
              manager.cancelNewSuggestionsRequest();
              manager.hideSuggestionList();
            } else {
              safeShowOrHide.call(manager, options);
            }
          } else {
            safeShowOrHide.call(manager, options);
          }
        };

        manager.displaySuggestions = (suggestions, options) => {
          if (element.querySelector('kite-signature')) {
            const desc = element.querySelector('.suggestion-description');
            if (desc) {
              if (suggestions.length === 0) {
                desc.style.display = 'none';
              } else {
                desc.style.display = '';
              }
            }

            if (parseFloat(autocompletePlus.metadata.version) >= 2.36) {
              manager.showSuggestionList(manager.getUniqueSuggestions(suggestions, s => s.text), options);
            } else {
              manager.showSuggestionList(manager.getUniqueSuggestions(suggestions), options);
            }
          } else {
            safeDisplay.call(manager, suggestions, options);
          }
        };
      }

      if (safeUpdate) {
        listElement.updateDescription = (item) => {
          safeUpdate.call(listElement, item);

          if (!item) {
            if (listElement.model && listElement.model.items) {
              item = listElement.model.items[listElement.selectedIndex];
            }
          }

          if (item && item.descriptionHTML) {
            listElement.descriptionContainer.classList.add('kite-completions');
            listElement.descriptionContent.innerHTML = item.descriptionHTML;

            if (typeof listElement.setDescriptionMoreLink === 'function') {
              listElement.setDescriptionMoreLink(item);
            }
          }
        };

        if (!listElement.ol) { listElement.renderList(); }
      } else {
        listElement.descriptionContainer.classList.remove('kite-completions');
      }
    });
  },
};
