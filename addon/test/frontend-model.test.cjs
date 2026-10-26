const {test} = require('node:test');
const assert = require('node:assert/strict');
const load=()=>import('../bms_zigbee/rootfs/opt/bms-ui/model.mjs');
test('controls follow writable exposes, including endpoint and value types',async()=>{
    const {features,controls,mainState}=await load();
    const d={definition:{exposes:[{type:'switch',endpoint:'l1',features:[{type:'binary',name:'state',property:'state_l1',access:7,value_on:true,value_off:false}]},{type:'numeric',name:'temperature',property:'temperature',access:1},{type:'numeric',property:'unsafe',access:2},{type:'composite',property:'color',features:[{type:'numeric',property:'x',access:7,value_min:0,value_max:1}]}]}};
    assert.equal(features(d)[0].endpoint,'l1');assert.equal(controls(d).length,1);
    assert.equal(mainState(d,{}),'unknown');assert.equal(mainState(d,{state_l1:true}),'on');assert.equal(mainState(d,{state_l1:false}),'off');
});
test('group control requires all known member endpoints to support OnOff',async()=>{
    const {groupSwitchable,isRoom,roomName}=await load();
    const group={id:1000,friendly_name:'Комната · Кухня',members:[{ieee_address:'a',endpoint:2}]};
    const d={ieee_address:'a',endpoints:{1:{clusters:{input:['genOnOff']}},2:{clusters:{input:[]}}}};
    assert.equal(groupSwitchable(group,[d]),false);d.endpoints[2].clusters.input=[6];assert.equal(groupSwitchable(group,[d]),true);
    assert.equal(groupSwitchable({...group,members:[...group.members,{ieee_address:'missing',endpoint:1}]},[d]),false);
    assert.equal(groupSwitchable({...group,members:[]},[d]),false);
    assert.equal(isRoom(group),true);assert.equal(roomName(group),'Кухня');assert.equal(isRoom({...group,id:1}),false);
});
test('WebSocket retains ingress prefix and names reject MQTT wildcards',async()=>{
    const {wsURL,validName}=await load();
    assert.equal(wsURL({href:'https://example.test/api/hassio_ingress/test/?demo=1#devices'},'a+b'),'wss://example.test/api/hassio_ingress/test/api?token=a%2Bb');
    for(const name of ['','a/b','a+','a#','bridge','a\n'])assert.equal(validName(name),false);
    assert.equal(validName('Гостиная · торшер'),true);
});
test('network map uses only returned links and preserves direction',async()=>{
 const {mapGraph,safeServer}=await import('../bms_zigbee/rootfs/opt/bms-ui/network.mjs');
 const graph=mapGraph({nodes:[{ieeeAddr:'a',friendlyName:'A'},{ieeeAddr:'b',friendlyName:'B'},{ieeeAddr:'c',friendlyName:'C'}],links:[{source:{ieeeAddr:'a'},target:{ieeeAddr:'b'},linkquality:75},{source:'missing',target:'b'}]});
 assert.equal(graph.nodes.length,3);assert.equal(graph.links.length,1);assert.equal(graph.links[0].from.id,'a');assert.equal(graph.links[0].to.id,'b');
 assert.equal(mapGraph({nodes:[{ieeeAddr:'a'}],links:[]}).links.length,0);
 assert.throws(()=>mapGraph({nodes:[]}),/формат/);
 assert.equal(safeServer('mqtt://admin:secret@192.168.1.10:1883/path?token=abc'),'mqtt://192.168.1.10:1883');
 assert.equal(safeServer('unparseable password'),'Адрес скрыт: неизвестный формат');
});
