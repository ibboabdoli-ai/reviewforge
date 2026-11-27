export function returnUnit({reservation,unit,inventory}){
  if(reservation.returned)return {ok:false,reason:'already-returned'};
  reservation.returned=true;
  inventory.set(unit.id,(inventory.get(unit.id)||0)+1);
  return {ok:true};
}
