'use struct';

const {withKite, withKitePaths} = require('kite-api/test/helpers/kite');

const KiteApp = require('../../lib/kite-app');
const KiteStatus = require('../../lib/elements/kite-status');
const KiteEditors = require('../../lib/editors');

describe('KiteStatus', () => {
  let status, app, editors;

  beforeEach(() => {
    app = new KiteApp();
    status = new KiteStatus();
    editors = new KiteEditors();
    app.kite = {
      getModule(mod) {
        if (mod === 'editors') {
          return editors;
        }
      },
    };
    status.setApp(app);

    document.body.appendChild(status);
  });

  it('starts in an unknown state', () => {
    expect(status.getAttribute('status')).toEqual('unknown');
  });

  withKite({installed: false}, () => {
    it('changes its status to UNINSTALLED', () => {
      waitsForPromise(() => app.connect().then(() => {
        expect(status.getAttribute('status')).toEqual('uninstalled');
        expect(status.querySelector('.text').textContent).toEqual('Kite: not installed');
        expect(status.querySelector('svg')).not.toBeNull();
      }));
    });
  });

  withKite({running: false}, () => {
    it('changes its status to INSTALLED', () => {
      waitsForPromise(() => app.connect().then(() => {
        expect(status.getAttribute('status')).toEqual('installed');
        expect(status.querySelector('.text').textContent).toEqual('Kite: not running');
        expect(status.querySelector('svg')).not.toBeNull();
      }));
    });
  });

  withKite({reachable: false}, () => {
    it('changes its status to RUNNING', () => {
      waitsForPromise(() => app.connect().then(() => {
        expect(status.getAttribute('status')).toEqual('running');
      }));
    });
  });

  withKite({logged: false}, () => {
    it('changes its status to REACHABLE', () => {
      waitsForPromise(() => app.connect().then(() => {
        expect(status.getAttribute('status')).toEqual('reachable');
        expect(status.querySelector('.text').textContent).toEqual('Kite: not logged in');
        expect(status.querySelector('svg')).not.toBeNull();
      }));
    });
  });

  withKite({logged: true}, () => {
    withKitePaths({}, undefined, () => {
      it('changes its status to AUTHENTICATED', () => {
        waitsForPromise(() => app.connect().then(() => {
          expect(status.getAttribute('status')).toEqual('authenticated');
          expect(status.querySelector('.text').textContent).toEqual('');
        }));
      });
    });
  });
});
