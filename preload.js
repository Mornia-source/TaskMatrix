const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, v) => fn(v));

contextBridge.exposeInMainWorld('api', {
  // 数据与设置（主进程持有唯一副本，改动会广播给所有窗口）
  load: () => ipcRenderer.invoke('data:load'),
  save: (data) => ipcRenderer.invoke('data:save', data),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.send('settings:set', patch),
  onDataChanged: on('data-changed'),
  onSettingsChanged: on('settings-changed'),
  taskCompleted: (info) => ipcRenderer.send('task:completed', info),
  onTaskCompleted: on('task-completed'),
  taskOp: (op) => ipcRenderer.send('task:op', op),   // { op: complete|delete|move|edit, id, q }
  onTaskOp: on('task-op'),

  // 主面板
  hide: () => ipcRenderer.send('win:hide'),
  setPinned: (v) => ipcRenderer.send('win:pin', v),
  getPinned: () => ipcRenderer.invoke('win:getPinned'),
  onShown: on('window-shown'),
  shownAck: (token) => ipcRenderer.send('win:shown-ack', token),
  panelReady: () => ipcRenderer.send('panel:ready'),
  onPinChanged: on('pin-changed'),

  // 任务栏小组件
  widgetDrag: (info) => ipcRenderer.send('widget:drag', info),
  widgetClick: () => ipcRenderer.send('widget:click'),
  widgetAdd: () => ipcRenderer.send('widget:add'),
  widgetReady: () => ipcRenderer.send('widget:ready'),
  widgetInfo: () => ipcRenderer.invoke('widget:info'),
  widgetPick: (info) => ipcRenderer.send('widget:pick', info),   // 点任务文字：下拉出同色任务
  onWidgetPicked: on('widget-picked'),
  onOpenBar: on('open-bar'),
  showTaskMenu: (id) => ipcRenderer.send('menu:showTask', id),
  onWidgetLayout: on('widget-layout'),

  // 右键菜单
  showMenu: () => ipcRenderer.send('menu:show'),
  onMenuOpen: on('menu-open'),
  menuReady: (height) => ipcRenderer.send('menu:ready', height),
  menuAction: (action, value) => ipcRenderer.send('menu:action', { action, value }),
});
