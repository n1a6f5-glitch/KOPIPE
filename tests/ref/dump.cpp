#define private public
#define protected public
// Reference dumper: walks a PSB with the original psb.cpp and prints a canonical text tree.
#include "psb.hpp"
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
static void esc(const string& s){ for(unsigned char c: s){ if(c=='\\'||c=='"') printf("\\%c",c); else if(c<0x20) printf("\\x%02x",c); else putchar(c);} }
static void walk(const psb_t& psb, psb_value_t* v, int depth);
static void walkObjects(const psb_t& psb, psb_objects_t* o, int depth){
  printf("OBJ %u\n", o->size());
  for(uint32_t i=0;i<o->size();i++){
    printf("%*s%s = ", depth*2+2, "", o->get_name(i).c_str());
    unsigned char* p = o->get_data(i); psb_value_t* c = psb.unpack(p); walk(psb,c,depth+1); delete c;
  }
}
static void walk(const psb_t& psb, psb_value_t* v, int depth){
  if(!v){ printf("UNKNOWN\n"); return; }
  if(auto* o=dynamic_cast<psb_objects_t*>(v)) { walkObjects(psb,o,depth); return; }
  if(auto* c=dynamic_cast<psb_collection_t*>(v)) {
    printf("COL %u\n", c->size());
    for(uint32_t i=0;i<c->size();i++){ printf("%*s[%u] ", depth*2+2, "", i); unsigned char* p=c->get(i); psb_value_t* e=psb.unpack(p); walk(psb,e,depth+1); delete e; }
    return; }
  if(auto* s=dynamic_cast<psb_string_t*>(v)) { printf("STR #%u \"", s->get_index()); esc(s->get_string()); printf("\"\n"); return; }
  if(auto* n=dynamic_cast<psb_number_t*>(v)) {
    if(n->get_number_type()==psb_number_t::INTEGER) printf("INT %lld\n",(long long)n->get_integer());
    else if(n->get_number_type()==psb_number_t::FLOAT) printf("FLOAT %.6g\n",(double)n->get_float());
    else printf("DOUBLE %.12g\n", n->get_double());
    return; }
  if(auto* b=dynamic_cast<psb_boolean_t*>(v)) { printf("BOOL %d\n", b->get_boolean()?1:0); return; }
  if(auto* a=dynamic_cast<psb_array_t*>(v)) { printf("ARR %u x%u\n", a->entry_count, a->entry_length); return; }
  if(auto* r=dynamic_cast<psb_resource_t*>(v)) { printf("RES #%u len=%u\n", r->get_index(), r->get_length()); return; }
  if(dynamic_cast<psb_null_t*>(v)) { printf("NULL\n"); return; }
  printf("OTHER\n");
}
int main(int argc,char** argv){
  std::ifstream f(argv[1], std::ios::binary); std::vector<unsigned char> buf((std::istreambuf_iterator<char>(f)), {});
  psb_t psb(buf.data());
  printf("HDR ver=%u enc=%u names=%u strings=%u sdata=%u cho=%u chl=%u chd=%u entries=%u\n", psb.hdr->version, psb.hdr->encrypt, psb.hdr->offset_names, psb.hdr->offset_strings, psb.hdr->offset_strings_data, psb.hdr->offset_chunk_offsets, psb.hdr->offset_chunk_lengths, psb.hdr->offset_chunk_data, psb.hdr->offset_entries);
  printf("NSTR %u\n", psb.strings->size());
  for(uint32_t i=0;i<psb.strings->size();i++){ printf("S%u \"", i); esc(string(psb.strings_data + psb.strings->get(i))); printf("\"\n"); }
  printf("ROOT "); const psb_objects_t* r = psb.get_objects(); if(r) walkObjects(psb,(psb_objects_t*)r,0); else printf("none\n");
  return 0; }
// psb.cpp (as shipped) declares but never defines this; the dumper needs it.
psb_number_t::psb_number_type_t psb_number_t::get_number_type() const { return number_type; }
